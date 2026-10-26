import json
import sys
import urllib.request

base = sys.argv[1]
rid = sys.argv[2]
d = json.load(urllib.request.urlopen(f"{base}/api/runs/{rid}"))
for n in ("final_gate", "execute_verifikasi", "emit_summary"):
    nd = d["nodes"][n]
    print(f"{n}: {nd['status']}  summary={nd.get('summary')}")
ev = d["nodes"]["execute_verifikasi"]
print("execute_verifikasi proposedMutations:", len(ev.get("proposedMutations", [])))
print("RUN STATUS:", d["status"])
