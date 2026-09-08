"""Independent specification probes. NOT CapitalDesk implementation or venue tests.

Run: python3 capitaldesk-review-probes.py
Only Python standard library; no credentials, network calls, or exchange writes.
"""
from decimal import Decimal as D
from fractions import Fraction as F
from itertools import product
import json

results = {"evidence_class": "independent specification models, not production tests"}

# Recalculate the documented partial-fill example without production helpers.
quote = D("0.02") * D("19900")
fee = quote * D("0.001")
each_quote = D("500") - (quote + fee) / 2
assert each_quote == D("300.801")
assert each_quote * 2 == D("601.602")
results["golden_partial"] = {"each_strategy_quote": str(each_quote),
                            "each_strategy_base": "0.01", "verified": True}

# Exhaustively enumerate row-conserving floor/ceil allocations for T-055.
shares = [[F(3, 10), F(3, 10), F(4, 10), F(0), F(0)],
          [F(0), F(0), F(4, 10), F(3, 10), F(3, 10)]]
floor = lambda x: x.numerator // x.denominator
ceil = lambda x: -((-x.numerator) // x.denominator)
row_options = []
for row in shares:
    opts = [sorted({floor(x), ceil(x)}) for x in row]
    row_options.append([v for v in product(*opts) if sum(v) == 1])
feasible = []
for matrix in product(*row_options):
    cols = [sum(row[i] for row in matrix) for i in range(5)]
    ideal = [sum(row[i] for row in shares) for i in range(5)]
    if all(floor(x) <= c <= ceil(x) for x, c in zip(ideal, cols)) and cols[2] <= 1:
        feasible.append(matrix)
assert len(feasible) == 8
results["T055_independent_enumeration"] = {"feasible_matrices": len(feasible),
    "one_feasible_matrix": feasible[0], "per_fill_largest_remainder_C_debit": 2,
    "C_approved_cap": 1, "note": "Supports this fixture, not a proof of the general solver."}

# The documented conflict rule sees the current candidate cohort only.
def conflict(deltas):
    return any(v > 0 for v in deltas) and any(v < 0 for v in deltas)
assert conflict([-1, 1])
assert not conflict([-1, 0]) and not conflict([0, 1])
results["sequential_reversal"] = {"simultaneous_sell_buy_conflict": True,
    "sell_cycle_conflict": conflict([-1, 0]), "later_buy_cycle_conflict": conflict([0, 1]),
    "note": "Separate owner approvals remain required; no automatic policy prevents this reversal."}

# A valid marker-time expiry check alone imposes no bound on a later send.
expiry, marker_time, resumed_send_time = 100, 99, 130
assert marker_time < expiry < resumed_send_time
results["post_marker_expiry_gap"] = {"expiry": expiry, "marker_time": marker_time,
    "resumed_send_time": resumed_send_time, "marker_check_passes": True,
    "note": "Possible under underspecified signing timing; not a reproduced executor bug."}

# Model only transitions permitted after marker with no decisive venue evidence.
state = ("UNKNOWN", "RESERVED", "POOL_BLOCKED")
for _ in range(1000):
    next_state = state  # NOT_FOUND without decisive coverage is not terminality.
    assert next_state == state
results["unknown_absence_fixed_point"] = {"state_after_1000_inconclusive_reads": state,
    "note": "Documents intentionally preserve safety, but specify no successful absence exit."}

# A venue sees one order; either local FIFO schedule can produce its same fill.
venue_fact = {"gross_base_fill": 1, "gross_quote_cost": 10}
possible_ownership = [{"A": 1, "B": 0}, {"A": 0, "B": 1}]
assert all(sum(v.values()) == venue_fact["gross_base_fill"] for v in possible_ownership)
results["lost_fifo_restore_information"] = {"venue_fact": venue_fact,
    "possible_local_ownership": possible_ownership,
    "note": "Venue reconciliation cannot recover a lost local allocation schedule uniquely."}

print(json.dumps(results, indent=2))
