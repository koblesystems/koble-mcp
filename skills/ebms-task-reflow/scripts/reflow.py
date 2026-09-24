#!/usr/bin/env python3
"""Plan a task reflow: pack each worker's tasks into working blocks with no overlaps.

Usage:
    python reflow.py input.json [--out plan.json]

input.json:
{
  "config": {
    "days": ["2026-09-25", "2026-09-28", ...],   # working days, in order
    "day_start": "09:00", "day_end": "17:00",
    "lunch_start": "12:00", "lunch_end": "13:00",  # omit both for no lunch
    "changeover_min": 15,
    "order": "original",        # original | priority | due
    "duration": "slot",         # slot (end - start) | hours (HOURS field)
    "day_map": {"2026-09-21": "2026-09-28"}   # optional: preferred new day per old day
  },
  "tasks": [
    {"id": "TK00001234", "autoid": "...", "worker": "RIVALE",
     "start_date": "2026-09-21", "start_time": "PT9H", "end_time": "PT9H30M",
     "hours": 0.5, "priority_sort": 2, "due": "2026-09-30"}
  ]
}

Tasks with no start/end time are moved by date only (see day_map) and never packed.
A task is never split across lunch or across days. Uses an integer program (pulp)
to fit everything with the fewest moves; falls back to a greedy pass if pulp is
missing. Prints a readable schedule and writes plan.json.
"""
import json, re, sys, argparse
from datetime import date


def to_min(t):
    """'PT9H30M', '09:30', '09:30:00' -> minutes after midnight; None stays None."""
    if not t:
        return None
    if t.startswith("PT"):
        h = re.search(r"(\d+)H", t); m = re.search(r"(\d+)M", t)
        return (int(h.group(1)) if h else 0) * 60 + (int(m.group(1)) if m else 0)
    p = t.split(":")
    return int(p[0]) * 60 + int(p[1])


def hhmmss(m):
    return f"{m // 60:02d}:{m % 60:02d}:00"


def label(m):
    return f"{m // 60}:{m % 60:02d}"


def blocks_for(cfg):
    ds, de = to_min(cfg["day_start"]), to_min(cfg["day_end"])
    ls, le = to_min(cfg.get("lunch_start")), to_min(cfg.get("lunch_end"))
    if ls is None or le is None:
        return [(ds, de)]
    return [(ds, ls), (le, de)]


def sort_key(order):
    if order == "priority":
        return lambda t: (t.get("priority_sort", 99), t["_od"], t["_s"])
    if order == "due":
        return lambda t: (t.get("due") or "9999", t["_od"], t["_s"])
    return lambda t: (t["_od"], t["_s"])


def solve_ilp(tasks, slots, cap, pref, co):
    import pulp
    P = pulp.LpProblem("reflow", pulp.LpMinimize)
    x = {(i, k): pulp.LpVariable(f"x_{i}_{k}", cat="Binary")
         for i in range(len(tasks)) for k in range(len(slots))}
    P += pulp.lpSum(pref(tasks[i], slots[k]) * x[i, k] for (i, k) in x)
    for i in range(len(tasks)):
        P += pulp.lpSum(x[i, k] for k in range(len(slots))) == 1
    for k in range(len(slots)):
        P += pulp.lpSum((tasks[i]["_dur"] + co) * x[i, k] for i in range(len(tasks))) <= cap[k] + co
    P.solve(pulp.PULP_CBC_CMD(msg=0))
    if pulp.LpStatus[P.status] != "Optimal":
        return None
    return {i: k for (i, k) in x if x[i, k].value() > 0.5}


def solve_greedy(tasks, slots, cap, co, key):
    used = [0] * len(slots); first = [True] * len(slots); out = {}
    for i, t in sorted(enumerate(tasks), key=lambda it: key(it[1])):
        start_k = next((k for k, s in enumerate(slots) if s[0] >= t["_target"]), 0)
        for k in list(range(start_k, len(slots))) + list(range(0, start_k)):
            need = t["_dur"] + (0 if first[k] else co)
            if used[k] + need <= cap[k]:
                used[k] += need; first[k] = False; out[i] = k; break
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input"); ap.add_argument("--out", default="plan.json")
    a = ap.parse_args()
    data = json.load(open(a.input)); cfg = data["config"]
    days = cfg["days"]; co = int(cfg.get("changeover_min", 15))
    day_map = cfg.get("day_map", {})
    blocks = blocks_for(cfg)
    slots = [(d, b) for d in range(len(days)) for b in range(len(blocks))]
    cap = [blocks[b][1] - blocks[b][0] for _, b in slots]
    key = sort_key(cfg.get("order", "original"))

    timed, untimed = [], []
    for t in data["tasks"]:
        t["_s"], t["_e"] = to_min(t.get("start_time")), to_min(t.get("end_time"))
        t["_od"] = t["start_date"][:10]
        if t["_s"] is None or t["_e"] is None:
            untimed.append(t); continue
        slot_len = t["_e"] - t["_s"]
        hrs = round(float(t.get("hours") or 0) * 60)
        t["_dur"] = hrs if cfg.get("duration") == "hours" and hrs > 0 else slot_len
        t["_hours_min"] = hrs
        target = day_map.get(t["_od"], t["_od"])
        t["_target"] = days.index(target) if target in days else 0
        t["_blk"] = 0 if t["_s"] < blocks[0][1] else len(blocks) - 1
        timed.append(t)

    def pref(t, s):
        d, b = s
        return 10 * abs(d - t["_target"]) + (3 if d < t["_target"] else 0) + (1 if b != t["_blk"] else 0)

    plan, unplaced, method = [], [], None
    for w in sorted({t["worker"] for t in timed}):
        ts = [t for t in timed if t["worker"] == w]
        too_long = [t for t in ts if t["_dur"] > max(cap)]
        ts = [t for t in ts if t not in too_long]
        unplaced += too_long
        assign = None
        try:
            assign = solve_ilp(ts, slots, cap, pref, co); method = method or "ilp"
        except ImportError:
            pass
        if assign is None:
            assign = solve_greedy(ts, slots, cap, co, key); method = "greedy"
        for k in range(len(slots)):
            members = sorted([ts[i] for i, kk in assign.items() if kk == k], key=key)
            cur = blocks[slots[k][1]][0]
            bend = blocks[slots[k][1]][1]
            nd = days[slots[k][0]]
            for n, t in enumerate(members):
                s = cur
                # Keep the task's own time of day when it is later than the cursor and
                # everything after it in this block still fits.
                if t["_target"] == slots[k][0] and t["_s"] > cur:
                    rest = members[n + 1:]
                    need_after = sum(r["_dur"] + co for r in rest)
                    if t["_s"] + t["_dur"] + need_after <= bend:
                        s = t["_s"]
                e = s + t["_dur"]
                plan.append({
                    "id": t["id"], "autoid": t.get("autoid"), "worker": w,
                    "old_date": t["_od"], "old_start": label(t["_s"]), "old_end": label(t["_e"]),
                    "new_date": nd, "new_start": hhmmss(s), "new_end": hhmmss(e),
                    "changed": (nd, s, e) != (t["_od"], t["_s"], t["_e"]),
                    # EBMS sets END = START + HOURS when the start moves, so a second
                    # write for the end is needed whenever HOURS differs from the slot.
                    "needs_end_write": t["_hours_min"] != t["_dur"],
                })
                cur = e + co
        unplaced += [ts[i] for i in range(len(ts)) if i not in assign]

    moves_date_only = [{"id": t["id"], "autoid": t.get("autoid"), "worker": t["worker"],
                        "old_date": t["_od"], "new_date": day_map.get(t["_od"], t["_od"])}
                       for t in untimed]
    out = {"method": method, "plan": plan, "date_only": moves_date_only,
           "unplaced": [{"id": t["id"], "worker": t["worker"], "minutes": t.get("_dur")} for t in unplaced]}
    json.dump(out, open(a.out, "w"), indent=1)

    for w in sorted({p["worker"] for p in plan}):
        print(f"\n== {w} ==")
        for p in sorted([p for p in plan if p["worker"] == w], key=lambda p: (p["new_date"], p["new_start"])):
            was = "" if not p["changed"] else f"   (was {p['old_date']} {p['old_start']}-{p['old_end']})"
            flag = "  [end write]" if p["needs_end_write"] else ""
            print(f"{p['new_date']} {p['new_start'][:5]}-{p['new_end'][:5]}  {p['id']}{was}{flag}")
    for m in moves_date_only:
        print(f"date only: {m['id']} ({m['worker']}) {m['old_date']} -> {m['new_date']}")
    print(f"\nmethod={method} placed={len(plan)} changed={sum(p['changed'] for p in plan)} "
          f"unplaced={len(unplaced)} date_only={len(moves_date_only)}")
    if unplaced:
        print("UNPLACED:", ", ".join(f"{u['id']} ({u['worker']})" for u in out["unplaced"]))


if __name__ == "__main__":
    main()
