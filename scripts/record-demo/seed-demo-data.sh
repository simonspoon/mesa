#!/usr/bin/env bash
# Seeds a fresh MESA_DB with fictional demo data for the promo-video
# walkthrough (walkthrough.sh hardcodes the resulting ids: project 1 board,
# tasks 1-5, storyboard 1 with frames 1-3, project 2). Run against a
# throwaway db/port — never the real dev instance (see
# docs/mesa-live-server-verify in project memory: :7777 is live).
#
# Usage: MESA_DB=/path/to/throwaway.db scripts/record-demo/seed-demo-data.sh
set -euo pipefail

: "${MESA_DB:?set MESA_DB to a throwaway db path before running this}"
export MESA_DB

id() { python3 -c "import json,sys;print(json.load(sys.stdin)['id'])"; }

proj1=$(mesa project create "Acme Storefront Revamp" --no-git | id)
t1=$(mesa task create "$proj1" "Design new checkout flow" --priority high | id)
mesa task update "$t1" --status done >/dev/null
t2=$(mesa task create "$proj1" "Implement payment gateway integration" --priority high | id)
mesa task update "$t2" --status in_progress >/dev/null
mesa task create "$proj1" "Wire up Stripe webhook" --parent "$t2" >/dev/null
t3=$(mesa task create "$proj1" "QA regression pass" --priority medium | id)
t4=$(mesa task create "$proj1" "Launch checkout redesign" --priority high | id)
mesa task block "$t4" --by "$t2" >/dev/null
mesa task block "$t4" --by "$t3" >/dev/null
mesa inbox add "Customers report the old checkout still shows on mobile Safari" >/dev/null

sb=$(mesa storyboard create "$proj1" "Checkout Flow" | id)
f1=$(mesa storyboard frame create "$sb" "Cart" --x 40 --y 120 | id)
f2=$(mesa storyboard frame create "$sb" "Payment" --x 360 --y 120 | id)
f3=$(mesa storyboard frame create "$sb" "Confirmation" --x 680 --y 120 | id)
mesa storyboard edge create "$sb" "$f1" "$f2" >/dev/null
mesa storyboard edge create "$sb" "$f2" "$f3" >/dev/null

proj2=$(mesa project create "Mobile App Launch" --no-git | id)
mesa task create "$proj2" "Submit App Store review" --priority medium >/dev/null
mesa task create "$proj2" "Write release notes" --priority low >/dev/null

echo "seeded: project $proj1 (tasks $t1-$t4), storyboard $sb (frames $f1-$f3), project $proj2" >&2
