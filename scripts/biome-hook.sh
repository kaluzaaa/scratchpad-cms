#!/usr/bin/env bash
# Claude Code PostToolUse hook: format edited .ts files with Biome.
# Reads hook JSON from stdin, extracts tool_input.file_path, runs biome on it.
# Never blocks edits: always exits 0.

input=$(cat)

if command -v jq >/dev/null 2>&1; then
  file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
else
  file=$(printf '%s' "$input" | node -e '
    let d = "";
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => {
      try {
        process.stdout.write(JSON.parse(d).tool_input?.file_path ?? "");
      } catch {}
    });
  ' 2>/dev/null)
fi

if [ -n "$file" ] && [ "${file%.ts}" != "$file" ]; then
  npx biome check --write "$file" >/dev/null 2>&1 || true
fi

exit 0
