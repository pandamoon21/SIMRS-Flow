#!/usr/bin/env bash
# Live end-to-end test of the SIMRS-Flow orchestrator against a real HTTP server.
set -uo pipefail
cd "$(dirname "$0")/.."  # repo root

PORT=4711
MOCK_PORT=4799
AUDIT_DIR="$(pwd)/.data/livetest-audit"
rm -rf "$AUDIT_DIR"; mkdir -p "$AUDIT_DIR"

pass=0; fail=0
ok()   { echo "PASS: $1"; pass=$((pass+1)); }
bad()  { echo "FAIL: $1"; fail=$((fail+1)); }
chk()  { if eval "$2"; then ok "$1"; else bad "$1 :: [$2]"; fi; }

echo "### booting mock EvoMedis login server on $MOCK_PORT ###"
node scripts/mock-login-server.mjs "$MOCK_PORT" > .data/mock-login.log 2>&1 &
MOCK_PID=$!

echo "### booting orchestrator (FileLedger at $AUDIT_DIR) ###"
# Point the per-user login at the mock server. Run data still uses fixtures.
ORCHESTRATOR_PORT=$PORT AUDIT_LEDGER_DIR="$AUDIT_DIR" \
  EVOMEDIS_BASE_URL="http://127.0.0.1:$MOCK_PORT/evoMedis_pkugombong/index.php" \
  node --import tsx apps/orchestrator/src/main.ts > .data/livetest.log 2>&1 &
PID=$!
trap 'kill $PID $MOCK_PID 2>/dev/null' EXIT

for i in $(seq 1 40); do
  curl -s "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 0.5
done

# ---- 1. health ----
H=$(curl -s "http://127.0.0.1:$PORT/api/health")
echo "health: $H"
chk "health ok:true" '[[ "$H" == *"\"ok\":true"* ]]'

# Authenticate once before exercising protected workflow/run reads.
BADLOGIN=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:$PORT/api/auth/login" -H "Content-Type: application/json" \
  -d '{"username":"baduser","password":"x"}')
chk "login with bad credentials 401s" '[[ "$BADLOGIN" == "401" ]]'
LOGIN_A=$(curl -s -X POST "http://127.0.0.1:$PORT/api/auth/login" -H "Content-Type: application/json" -d '{"username":"alice","password":"pw"}')
TOK_A=$(echo "$LOGIN_A" | sed -E 's/.*"token":"([^"]+)".*/\1/')
chk "alice login returns a token" '[[ -n "$TOK_A" && "$LOGIN_A" == *"\"operator\":\"alice\""* ]]'
LOGIN_B=$(curl -s -X POST "http://127.0.0.1:$PORT/api/auth/login" -H "Content-Type: application/json" -d '{"username":"bob","password":"pw"}')
TOK_B=$(echo "$LOGIN_B" | sed -E 's/.*"token":"([^"]+)".*/\1/')
chk "bob login returns a token" '[[ -n "$TOK_B" ]]'
AUTH=(-H "Authorization: Bearer $TOK_A")

# ---- 2. workflows ----
ANON_READ=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/api/workflows")
chk "anonymous workflow read 401s" '[[ "$ANON_READ" == "401" ]]'
WF=$(curl -s "${AUTH[@]}" "http://127.0.0.1:$PORT/api/workflows")
chk "lists ranap" '[[ "$WF" == *"ranap-verifikasi-tampung-bayar"* ]]'
chk "lists rajal" '[[ "$WF" == *"rajal-patient-processor"* ]]'
chk "ranap has 33 nodes" '[[ "$WF" == *"\"nodeCount\":33"* ]]'
chk "rajal has 21 nodes" '[[ "$WF" == *"\"nodeCount\":21"* ]]'

# ---- 3. workflow definition ----
DEF=$(curl -s "${AUTH[@]}" "http://127.0.0.1:$PORT/api/workflows/ranap-verifikasi-tampung-bayar")
chk "definition returns nodes" '[[ "$DEF" == *"\"nodes\""* && "$DEF" == *"load_visits"* ]]'
chk "unknown workflow 404s" '[[ "$(curl -s -o /dev/null -w "%{http_code}" "${AUTH[@]}" http://127.0.0.1:$PORT/api/workflows/nope)" == "404" ]]'

# ---- 4. preview run (ranap) ----
RUN=$(curl -s -X POST "http://127.0.0.1:$PORT/api/runs" -H "Content-Type: application/json" \
  -d '{"workflowId":"ranap-verifikasi-tampung-bayar","mode":"preview","input":{"noRm":"012345","tanggal":"2026-06-10"}}')
RID=$(echo "$RUN" | sed -E 's/.*"runId":"([^"]+)".*/\1/')
echo "ranap preview runId=$RID"
chk "run created with id" '[[ -n "$RID" && "$RID" == run_* ]]'
sleep 1

ST=$(curl -s "${AUTH[@]}" "http://127.0.0.1:$PORT/api/runs/$RID")
chk "load_visits success" '[[ "$ST" == *"\"load_visits\":{\"id\":\"load_visits\",\"status\":\"success\""* ]]'
chk "final_gate blocked (preview holds)" '[[ "$ST" == *"\"final_gate\""* && "$ST" == *"blocked"* ]]'
chk "run failed (critical gate blocked in preview)" '[[ "$ST" == *"\"status\":\"failed\""* ]]'
chk "no mutation applied (execute_verifikasi never ran to success)" '[[ "$ST" != *"\"execute_verifikasi\":{\"id\":\"execute_verifikasi\",\"status\":\"success\""* ]]'

# ---- 5. live SSE (the fix under test) ----
echo "### capturing live SSE frames ###"
SSE=$(curl -s --max-time 2 "${AUTH[@]}" "http://127.0.0.1:$PORT/api/runs/$RID/events")
NAMED=$(printf '%s\n' "$SSE" | grep -c '^event: ' || true)
DATA=$(printf '%s\n' "$SSE" | grep -c '^data: ' || true)
echo "sse: data-frames=$DATA named-frames=$NAMED"
chk "SSE emits data frames" '[[ "$DATA" -gt 0 ]]'
chk "SSE has zero named frames (browser onmessage works)" '[[ "$NAMED" -eq 0 ]]'
chk "SSE payload carries type field" '[[ "$SSE" == *"\"type\":\"run.created\""* ]]'
chk "SSE replays history to late subscriber" '[[ "$SSE" == *"\"type\":\"run.completed\""* || "$SSE" == *"\"type\":\"run.failed\""* ]]'

# ---- 6. JSONL export ----
EXP=$(curl -s "${AUTH[@]}" "http://127.0.0.1:$PORT/api/runs/$RID/export.jsonl")
LINES=$(printf '%s\n' "$EXP" | grep -c '"schema"' || true)
echo "export jsonl lines=$LINES"
chk "export returns many event lines" '[[ "$LINES" -gt 20 ]]'

# ---- 7. audit ledger on disk + redaction ----
echo "### audit ledger files ###"
ls -la "$AUDIT_DIR"
LEDGER=$(cat "$AUDIT_DIR/$RID.jsonl" 2>/dev/null)
chk "ledger file written for run" '[[ -n "$LEDGER" ]]'
chk "ledger has run.meta line" '[[ "$LEDGER" == *"run.meta"* ]]'

# ---- 8. rajal preview run ----
RUN2=$(curl -s -X POST "http://127.0.0.1:$PORT/api/runs" -H "Content-Type: application/json" \
  -d '{"workflowId":"rajal-patient-processor","mode":"preview","input":{"patientIds":["012345"],"clinics":["PENYAKIT DALAM"],"date":"2026-06-10"}}')
RID2=$(echo "$RUN2" | sed -E 's/.*"runId":"([^"]+)".*/\1/')
echo "rajal preview runId=$RID2"
sleep 1
ST2=$(curl -s "${AUTH[@]}" "http://127.0.0.1:$PORT/api/runs/$RID2")
chk "rajal submit_payment needs_review (plan, no write)" '[[ "$ST2" == *"submit_payment"* && "$ST2" == *"needs_review"* ]]'

# ---- 9. write-mode gate approval flow (auth + two-person) ----
echo "### write-mode auth + two-person gate approval ###"
# 9a. write run without a token is rejected (401)
NOAUTH=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:$PORT/api/runs" -H "Content-Type: application/json" \
  -d '{"workflowId":"ranap-verifikasi-tampung-bayar","mode":"write","input":{"noRm":"012345","tanggal":"2026-06-10"}}')
chk "write run without token 401s" '[[ "$NOAUTH" == "401" ]]'

# 9d. write run with alice's token
RUN3=$(curl -s -X POST "http://127.0.0.1:$PORT/api/runs" -H "Content-Type: application/json" -H "Authorization: Bearer $TOK_A" \
  -d '{"workflowId":"ranap-verifikasi-tampung-bayar","mode":"write","input":{"noRm":"012345","tanggal":"2026-06-10"}}')
RID3=$(echo "$RUN3" | sed -E 's/.*"runId":"([^"]+)".*/\1/')
echo "write runId=$RID3"
sleep 1
# A fixture write run parks on its re-plan plans (e.g. process_poli's POLI
# tidy-up must land before the run continues). Approve each pending plan with
# alice until the final gate is waiting; the critical gate itself is 9f/9g.
for i in $(seq 1 12); do
  ST3=$(curl -s "${AUTH[@]}" "http://127.0.0.1:$PORT/api/runs/$RID3")
  [[ "$ST3" == *"\"final_gate\":{\"nodeId\":\"final_gate\",\"status\":\"waiting\""* ]] && break
  PLAN=$(echo "$ST3" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const st=j.state??j;const m=Object.entries(st.mutations||{}).find(([,v])=>v.status==='planned');process.stdout.write(m?m[0]:'')})")
  [[ -z "$PLAN" ]] && { sleep 0.5; continue; }
  APR=$(curl -s -X POST "http://127.0.0.1:$PORT/api/runs/$RID3/mutations/$(node -e "process.stdout.write(encodeURIComponent(process.argv[1]))" "$PLAN")/approve" -H "Content-Type: application/json" -H "Authorization: Bearer $TOK_A" -d '{"reason":"livetest-replan"}')
  echo "replan approve #$i: $(echo "$APR" | grep -o '"status":"[a-z_]*"' | head -n 1)"
  sleep 0.5
done
chk "write run parks on its re-plan plans" '[[ "$i" -gt 1 || "$ST3" == *"waiting"* ]]'
chk "write run pauses at gate (gate_waiting)" '[[ "$ST3" == *"gate_waiting"* || "$ST3" == *"\"final_gate\":{\"nodeId\":\"final_gate\",\"status\":\"waiting\""* ]]'

# 9e. a second write run on the same record is locked (409)
LOCK=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:$PORT/api/runs" -H "Content-Type: application/json" -H "Authorization: Bearer $TOK_A" \
  -d '{"workflowId":"ranap-verifikasi-tampung-bayar","mode":"write","input":{"noRm":"012345","tanggal":"2026-06-10"}}')
chk "second write run on same record 409s (per-tx lock)" '[[ "$LOCK" == "409" ]]'

# 9f. first approval (alice) holds the critical gate — second approver required
APV1=$(curl -s -X POST "http://127.0.0.1:$PORT/api/runs/$RID3/gates/final_gate/approve" -H "Content-Type: application/json" -H "Authorization: Bearer $TOK_A" -d '{"reason":"livetest-alice"}')
echo "approve#1 response: $APV1"
chk "first critical approval holds (resolved=false)" '[[ "$APV1" == *"\"resolved\":false"* ]]'

# 9g. second distinct approver (bob) resolves the gate
APV2=$(curl -s -X POST "http://127.0.0.1:$PORT/api/runs/$RID3/gates/final_gate/approve" -H "Content-Type: application/json" -H "Authorization: Bearer $TOK_B" -d '{"reason":"livetest-bob"}')
echo "approve#2 response: $APV2"
sleep 1
ST3b=$(curl -s "${AUTH[@]}" "http://127.0.0.1:$PORT/api/runs/$RID3")
chk "second distinct approval resolves the gate" '[[ "$APV2" == *"\"resolved\":true"* || "$ST3b" == *"execute_verifikasi"* ]]'

# ---- 10. cancel (write run needs auth) ----
RUN4=$(curl -s -X POST "http://127.0.0.1:$PORT/api/runs" -H "Content-Type: application/json" -H "Authorization: Bearer $TOK_A" \
  -d '{"workflowId":"ranap-verifikasi-tampung-bayar","mode":"write","input":{"noRm":"999999","tanggal":"2026-06-10"}}')
RID4=$(echo "$RUN4" | sed -E 's/.*"runId":"([^"]+)".*/\1/')
CAN=$(curl -s -X POST "http://127.0.0.1:$PORT/api/runs/$RID4/cancel" -H "Authorization: Bearer $TOK_A")
chk "cancel returns cancelled:true" '[[ "$CAN" == *"\"cancelled\":true"* ]]'
chk "cancel unknown run 404s" '[[ "$(curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:$PORT/api/runs/run_nope/cancel -H "Authorization: Bearer $TOK_A")" == "404" ]]'

# 10b. logout invalidates the token
curl -s -X POST "http://127.0.0.1:$PORT/api/auth/logout" -H "Authorization: Bearer $TOK_A" >/dev/null
AFTER_LOGOUT=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:$PORT/api/runs" -H "Content-Type: application/json" -H "Authorization: Bearer $TOK_A" \
  -d '{"workflowId":"ranap-verifikasi-tampung-bayar","mode":"write","input":{"noRm":"012345","tanggal":"2026-06-10"}}')
chk "token rejected after logout (401)" '[[ "$AFTER_LOGOUT" == "401" ]]'

# ---- 11. runs listing ----
RUNS=$(curl -s -H "Authorization: Bearer $TOK_B" "http://127.0.0.1:$PORT/api/runs")
RCOUNT=$(printf '%s' "$RUNS" | grep -o '"runId"' | wc -l | tr -d ' ')
echo "runs tracked=$RCOUNT"
chk "lists multiple runs" '[[ "$RCOUNT" -ge 4 ]]'

echo ""
echo "================ RESULT: $pass passed, $fail failed ================"
[[ "$fail" -eq 0 ]]
