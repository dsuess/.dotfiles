import fs from "node:fs";
import path from "node:path";

/** Stage a read-only PATH compatibility command; native mktemp still creates names. */
export function materializeTempCommand(generationRoot, tempRoot) {
  const directory = path.join(generationRoot, "temp-bin");
  const executable = path.join(directory, "mktemp");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  fs.rmSync(executable, { force: true });
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(executable, `#!/bin/sh
root=${quote(tempRoot)}
# GNU mktemp already respects TMPDIR. BSD implicit forms need explicit paths.
${process.platform === "darwin" ? `original_count=$#
flags=
prefix=
has_prefix=
has_directory=
OPTERR=0
while getopts 'dqut:p:' option; do
  case "$option" in
    d|q|u) flags="$flags$option" ;;
    t) prefix=$OPTARG; has_prefix=yes ;;
    p) has_directory=yes ;;
    *) exec /usr/bin/mktemp "$@" ;;
  esac
done
# An explicit directory always retains native semantics, including errors.
if [ -n "$has_directory" ]; then exec /usr/bin/mktemp "$@"; fi
# No implicit prefix or default: preserve all explicit templates unchanged.
if [ -z "$has_prefix" ] && [ "$OPTIND" -le "$original_count" ]; then
  exec /usr/bin/mktemp "$@"
fi
shift "$((OPTIND - 1))"
if [ -n "$has_prefix" ]; then template="$root/$prefix.XXXXXXXXXX"; else template="$root/tmp.XXXXXXXXXX"; fi
if [ -n "$flags" ]; then set -- "-$flags" -- "$template" "$@"; else set -- -- "$template" "$@"; fi
exec /usr/bin/mktemp "$@"` : `TMPDIR=$root; export TMPDIR
exec /usr/bin/mktemp "$@"`}
`, { mode: 0o500 });
  fs.chmodSync(executable, 0o500);
  return Object.freeze({ directory, executable });
}
