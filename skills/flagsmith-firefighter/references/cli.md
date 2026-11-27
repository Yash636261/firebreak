# CLI calls behind the scripts

Load this only if a script fails and you need to do a step by hand.

| Purpose | Command |
|---|---|
| Resolved project / environment | `flagsmith config --json` → `.project.value`, `.environment.value` |
| Project id from name | `flagsmith project get <name> --jq .id` |
| Environment id + name from client key | `flagsmith environment get <key> --jq '{id,name}'` |
| Recent changes (audit log) | `flagsmith api "api/v1/audit/?project=<pid>&environments=<eid>&page_size=100" --jq '.results[] \| {created_date,log,author:.author.email}'` |
| One audit entry with field-level diff | `flagsmith api api/v1/audit/<id>/ --jq .change_details` |
| Flag state (default / segment) | `flagsmith flag get <f> [--segment <s>] --json` |
| Kill (default) | `flagsmith flag disable <f> -p <pid> -e <key> --yes --no-input` |
| Kill for one segment | `flagsmith flag disable <f> --segment <s> -p <pid> -e <key> --yes --no-input` |
| Roll a multivariate test back to control | `flagsmith flag update <f> --weight <control>=100 --weight <variant>=0 -p <pid> -e <key> --yes --no-input` |
| SDK-side check | `flagsmith eval <f> -e <key> --test` (non-zero exit = disabled) |
| Per-user check | `flagsmith eval <f> -e <key> --identity <id> --jq '{enabled,value}'` |

Self-hosted Flagsmith: add `--api-url <url>` or set `FLAGSMITH_API_URL`.

Audit log text looks like `Flag state / Remote Config updated for feature: <name>`; the feature name is after `feature:`.
