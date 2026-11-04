"""Run the save transaction with isolated sing-box, UCI and procd fixtures.

Usage: python3 -m unittest discover -s tests -p 'test_*.py'
No router services are called.
"""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
CORE = ROOT / 'root/usr/share/sing-box-panel/core.sh'

SETUP = r'''
. "$CORE"
RUN="$FIXTURE/run"
CONFIG="$FIXTURE/config.json"
WORKDIR="$FIXTURE/work"
SERVICE_USER="$(id -un)"
BIN="$FIXTURE/sing-box"
INIT="$FIXTURE/init"
mkdir -p "$RUN" "$WORKDIR"
printf '%s' '{"old":true}' > "$CONFIG"
chmod 640 "$CONFIG"
printf '%s' "$CONFIG" > "$FIXTURE/config-path"
export TEST_CONFIG="$CONFIG"
run_timeout() { shift; "$@"; }
uci() {
    case "$*" in
        '-q get sing-box.main.conffile') cat "$FIXTURE/config-path";;
        '-q get sing-box.main.workdir') printf '%s' "$FIXTURE/work";;
        '-q get sing-box.main.user') id -un;;
        'set sing-box.main.enabled=1'|'commit sing-box') printf '%s\n' "$*" >> "$FIXTURE/actions";;
        *) return 1;;
    esac
}
running_pid() { [ ! -f "$FIXTURE/running" ] || printf '%s' "$$"; }
ubus() { [ ! -f "$FIXTURE/status-failure" ] || return 1; printf '{}'; }
healthy() { [ ! -f "$FIXTURE/start-failure" ]; }
expected=$(config_revision)
'''

MOCK_BIN = r'''#!/bin/sh
printf 'check\n' >> "$FIXTURE/checks"
[ "$1" = check ] && [ "$2" = -c ] || exit 9
candidate="$3"
case "$(cat "$candidate")" in
    *INVALID*) echo 'invalid configuration' >&2; exit 12;;
    *EXTERNAL_EDIT*) printf '%s' '{"external":true}' > "$TEST_CONFIG";;
    *PATH_CHANGE*) printf '%s' "$FIXTURE/other.json" > "$FIXTURE/config-path";;
esac
# Validation must happen before the destination is overwritten.
if [ "$candidate" != "$TEST_CONFIG" ]; then
    cmp -s "$candidate" "$TEST_CONFIG" || printf 'before-commit\n' >> "$FIXTURE/checks"
fi
'''

MOCK_INIT = r'''#!/bin/sh
printf '%s\n' "$1" >> "$FIXTURE/actions"
[ ! -f "$FIXTURE/start-failure" ]
'''


class SaveTransactionTests(unittest.TestCase):
    def run_shell(self, body):
        with tempfile.TemporaryDirectory(prefix='sing-box-test.') as directory:
            folder = Path(directory)
            for name, text in [('sing-box', MOCK_BIN), ('init', MOCK_INIT)]:
                path = folder / name
                path.write_text(text)
                path.chmod(0o755)
            result = subprocess.run(
                ['sh', '-eu', '-c', SETUP + '\n' + body],
                env={**os.environ, 'CORE': str(CORE), 'FIXTURE': directory},
                text=True, capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_invalid_save_preserves_config_and_service(self):
        self.run_shell(r'''
touch "$FIXTURE/running"
if save_config INVALID "$expected"; then exit 1; fi
[ "$ERROR" = check_failed ]
[ "$ERROR_ARG" = 12 ]
[ "$(cat "$CONFIG")" = '{"old":true}' ]
[ ! -e "$FIXTURE/actions" ]
[ -z "$SAVE_REVISION" ]
[ -z "$SAVE_CANDIDATE" ]
''')

    def test_stopped_save_preserves_stopped_state_and_permissions(self):
        self.run_shell(r'''
save_config '{"new":true}' "$expected"
[ "$(cat "$CONFIG")" = '{"new":true}' ]
[ "$SAVE_CODE" = config_saved ]
[ "$SAVE_REVISION" = "$(config_revision)" ]
[ ! -e "$FIXTURE/actions" ]
[ "$(ls -l "$CONFIG" | cut -c 1-10)" = '-rw-r-----' ]
[ -z "$SAVE_CANDIDATE" ]
''')

    def test_running_save_checks_before_commit_and_restarts_once(self):
        self.run_shell(r'''
touch "$FIXTURE/running"
save_config '{"new":true}' "$expected"
[ "$SAVE_CODE" = config_applied ]
[ "$(grep -c '^check$' "$FIXTURE/checks")" = 1 ]
grep -q '^before-commit$' "$FIXTURE/checks"
[ "$(grep -c '^restart$' "$FIXTURE/actions")" = 1 ]
! grep -Eq '^(enable|disable|start|stop)$' "$FIXTURE/actions"
''')

    def test_unchanged_save_does_not_restart(self):
        self.run_shell(r'''
touch "$FIXTURE/running"
save_config '{"old":true}' "$expected"
[ "$SAVE_CODE" = config_unchanged ]
[ ! -e "$FIXTURE/actions" ]
''')

    def test_stale_editor_is_rejected_before_validation(self):
        self.run_shell(r'''
if save_config '{"new":true}' stale; then exit 1; fi
[ "$ERROR" = config_changed ]
[ ! -e "$FIXTURE/checks" ]
[ "$(cat "$CONFIG")" = '{"old":true}' ]
''')

    def test_external_edit_during_validation_is_not_overwritten(self):
        self.run_shell(r'''
if save_config '{"EXTERNAL_EDIT":true}' "$expected"; then exit 1; fi
[ "$ERROR" = config_changed ]
[ "$(cat "$CONFIG")" = '{"external":true}' ]
[ ! -e "$FIXTURE/actions" ]
[ -z "$SAVE_CANDIDATE" ]
''')

    def test_path_change_during_validation_is_rejected(self):
        self.run_shell(r'''
if save_config '{"PATH_CHANGE":true}' "$expected"; then exit 1; fi
[ "$ERROR" = config_changed ]
[ "$(cat "$TEST_CONFIG")" = '{"old":true}' ]
[ ! -e "$FIXTURE/other.json" ]
[ ! -e "$FIXTURE/actions" ]
[ -z "$SAVE_CANDIDATE" ]
''')

    def test_restart_failure_reports_saved_revision(self):
        self.run_shell(r'''
touch "$FIXTURE/running" "$FIXTURE/start-failure"
if save_config '{"new":true}' "$expected"; then exit 1; fi
[ "$ERROR" = apply_failed ]
[ "$(cat "$CONFIG")" = '{"new":true}' ]
[ "$SAVE_REVISION" = "$(config_revision)" ]
''')

    def test_new_config_is_private(self):
        self.run_shell(r'''
rm "$CONFIG"
expected=$(config_revision)
save_config '{"new":true}' "$expected"
[ "$(ls -l "$CONFIG" | cut -c 1-10)" = '-rw-------' ]
''')

    def test_status_failure_preserves_destination_and_cleanup_removes_candidate(self):
        self.run_shell(r'''
touch "$FIXTURE/status-failure"
if save_config '{"new":true}' "$expected"; then exit 1; fi
[ "$ERROR" = service_status_failed ]
[ "$(cat "$CONFIG")" = '{"old":true}' ]
candidate="$SAVE_CANDIDATE"
worker_exit
[ ! -e "$candidate" ]
''')

    def test_boot_switch_does_not_start_or_stop_service(self):
        self.run_shell(r'''
rm "$CONFIG"
set_autostart 1
set_autostart 0
[ "$(grep -c '^enable$' "$FIXTURE/actions")" = 1 ]
[ "$(grep -c '^disable$' "$FIXTURE/actions")" = 1 ]
! grep -Eq '^(start|restart|stop)$' "$FIXTURE/actions"
''')

    def test_start_checks_config_without_changing_boot(self):
        self.run_shell(r'''
start_service start start_failed
grep -q '^start$' "$FIXTURE/actions"
! grep -Eq '^(enable|disable)$' "$FIXTURE/actions"
''')

    def test_stop_settings_allow_broken_config(self):
        self.run_shell(r'''
printf relative-path > "$FIXTURE/config-path"
action_settings stop
service_do stop
grep -q '^stop$' "$FIXTURE/actions"
! grep -Eq '^(enable|disable)$' "$FIXTURE/actions"
''')


if __name__ == '__main__':
    unittest.main()
