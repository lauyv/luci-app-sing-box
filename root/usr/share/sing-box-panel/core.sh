#!/bin/sh
# shellcheck shell=busybox
# Shared by the rpcd plugin and detached worker. No client-controlled paths/commands.
RUN=/tmp/sing-box-panel
INIT=/etc/init.d/sing-box
BIN=/usr/bin/sing-box
MAX_SIZE=65536

prepare() {
	umask 077
	[ "$(id -u)" = 0 ] || { DETAILS='面板后端必须以 root 身份运行'; return 1; }
	[ ! -L "$RUN" ] || { DETAILS="$RUN 是符号链接"; return 1; }
	mkdir -p "$RUN" || { DETAILS="无法创建 $RUN"; return 1; }
	# BusyBox ash supports -O without requiring a separate stat applet.
	[ -d "$RUN" ] && [ -O "$RUN" ] || {
		DETAILS="$RUN 必须是 root 所有的目录"; return 1;
	}
	chmod 700 "$RUN" || { DETAILS="无法设置 $RUN 的权限"; return 1; }
}

load_settings() {
	CONFIG=$(uci -q get sing-box.main.conffile)
	WORKDIR=$(uci -q get sing-box.main.workdir)
	SERVICE_USER=$(uci -q get sing-box.main.user)
	[ -n "$WORKDIR" ] || WORKDIR=/usr/share/sing-box
	[ -n "$SERVICE_USER" ] || SERVICE_USER=root
}

settings() {
	load_settings
	case "$CONFIG" in /*) ;; *) ERROR='config_path_invalid'; return 1;; esac
	case "$WORKDIR" in /*) ;; *) ERROR='workdir_invalid'; return 1;; esac
	[ ! -L "$CONFIG" ] || { ERROR='config_symlink'; return 1; }
	[ ! -e "$CONFIG" ] || [ -f "$CONFIG" ] || { ERROR=config_not_regular; return 1; }
	[ -x "$BIN" ] && [ -x "$INIT" ] || { ERROR='service_missing'; return 1; }
}

action_settings() {
	# Stopping a running service must work even if its configuration is broken.
	if [ "$1" = stop ]; then
		[ -x "$INIT" ] || { ERROR=service_missing; return 1; }
	else
		settings
	fi
}

lock() {
	mkdir "$RUN/lock" 2>/dev/null
}

unlock() {
	rm -f "$RUN/lock/pid"
	rmdir "$RUN/lock" 2>/dev/null
}

job() {
	json_init
	json_add_string state "$1"
	json_add_string code "$2"
	json_add_string argument "${4:-${ERROR_ARG:-}}"
	json_add_string details "${3:-}"
	json_add_int updated "$(date +%s)"
	json_dump > "$RUN/job.new" && mv -f "$RUN/job.new" "$RUN/job.json"
}

running_pid() {
	ubus call service list '{"name":"sing-box"}' 2>/dev/null |
		jsonfilter -e '@["sing-box"].instances.*.pid' 2>/dev/null | head -n 1
}

healthy() {
	# Require a stable live PID across three observations; a respawn is a failure.
	local first current _attempt
	sleep 1
	first=$(running_pid)
	[ -n "$first" ] && kill -0 "$first" 2>/dev/null || return 1
	for _attempt in 1 2; do
		sleep 1
		current=$(running_pid)
		[ "$current" = "$first" ] && kill -0 "$current" 2>/dev/null || return 1
	done
}

# Run a command with a bounded lifetime without requiring coreutils-timeout.
run_timeout() (
	trap - EXIT HUP INT TERM
	limit="$1"
	shift
	command_pid=''
	watchdog_pid=''
	# Called by the EXIT trap below, including timeout and signal exits.
	# shellcheck disable=SC2329
	cleanup_timeout() {
		[ -z "$watchdog_pid" ] || kill "$watchdog_pid" 2>/dev/null
		[ -z "$command_pid" ] || kill -KILL "$command_pid" 2>/dev/null
		[ -z "$watchdog_pid" ] || wait "$watchdog_pid" 2>/dev/null
	}
	trap cleanup_timeout EXIT
	trap 'exit 143' HUP INT TERM
	"$@" &
	command_pid=$!
	(
		trap - EXIT HUP INT TERM
		elapsed=0
		while kill -0 "$command_pid" 2>/dev/null; do
			sleep 1
			elapsed=$((elapsed + 1))
			if [ "$elapsed" -eq "$limit" ]; then
				kill -TERM "$command_pid" 2>/dev/null || exit 0
			elif [ "$elapsed" -ge "$((limit + 2))" ]; then
				kill -KILL "$command_pid" 2>/dev/null
				exit 0
			fi
		done
	) &
	watchdog_pid=$!
	wait "$command_pid"
	result=$?
	command_pid=''
	exit "$result"
)

service_do() {
	run_timeout 12 "$INIT" "$1" > "$RUN/service.log" 2>&1
}

check_config() {
	ERROR_ARG=''
	[ -f "$1" ] || { ERROR='config_missing'; return 1; }
	[ "$(wc -c < "$1")" -le "$MAX_SIZE" ] || { ERROR='config_too_large'; return 1; }
	run_timeout 15 "$BIN" check -c "$1" -D "$WORKDIR" > "$RUN/check.log" 2>&1
	local result=$?
	DETAILS=$(head -c 8192 "$RUN/check.log")
	[ "$result" -eq 0 ] || { ERROR=check_failed; ERROR_ARG="$result"; return 1; }
}

config_revision() {
	# Include the path so a UCI path change invalidates an open editor too.
	{ printf '%s\n' "$CONFIG"; if [ -f "$CONFIG" ]; then sha256sum "$CONFIG"; else printf 'missing\n'; fi; } |
		sha256sum | cut -d ' ' -f 1
}

stage_config() {
	local tmp
	[ ! -L "$CONFIG" ] && { [ ! -e "$CONFIG" ] || [ -f "$CONFIG" ]; } || return 1
	tmp=$(mktemp "${CONFIG}.panel.XXXXXX") || return 1
	if [ -f "$CONFIG" ]; then
		cp -p "$CONFIG" "$tmp" || { rm -f "$tmp"; return 1; }
	else
		if ! chown "$SERVICE_USER" "$tmp" || ! chmod 600 "$tmp"; then
			rm -f "$tmp"
			return 1
		fi
	fi
	printf '%s' "$1" > "$tmp" || { rm -f "$tmp"; return 1; }
	printf '%s' "$tmp"
}

save_config() {
	local content="$1" expected="$2" tmp
	[ -n "$expected" ] && [ "$expected" = "$(config_revision)" ] || {
		ERROR=config_changed; return 1;
	}
	tmp=$(stage_config "$content") || { ERROR=config_save_failed; return 1; }
	if [ -f "$CONFIG" ] && cmp -s "$tmp" "$CONFIG"; then
		rm -f "$tmp"
		return 0
	fi
	mv -f "$tmp" "$CONFIG" || { rm -f "$tmp"; ERROR=config_save_failed; return 1; }
}

start_service() {
	check_config "$CONFIG" || return 1
	if uci set sing-box.main.enabled=1 && uci commit sing-box && service_do "$1" && healthy; then
		return 0
	fi
	DETAILS=$(head -c 8192 "$RUN/service.log" 2>/dev/null)
	ERROR="$2"
	return 1
}

worker() {
	local action="$1" expected="${2:-}"
	printf '%s' "$$" > "$RUN/lock/pid"
	trap 'worker_exit' EXIT
	trap 'job error operation_interrupted; exit 1' HUP INT TERM
	job running operation_running '' "$action"
	action_settings "$action" || { job error "$ERROR"; return 1; }
	case "$action" in apply)
		[ "$expected" = "$(config_revision)" ] || { job error config_changed; return 1; };;
	esac
	case "$action" in
		validate)
			check_config "$RUN/validation.json" || { job error "$ERROR" "$DETAILS"; return 1; }
			job success check_passed "$DETAILS";;
		apply)
			start_service restart apply_failed || { job error "$ERROR" "$DETAILS"; return 1; }
			job success 'config_applied';;
		start|restart)
			start_service "$action" start_failed || { job error "$ERROR" "$DETAILS"; return 1; }
			job success 'service_running';;
		stop)
			service_do stop || {
				job error stop_failed "$(head -c 8192 "$RUN/service.log" 2>/dev/null)"; return 1;
			}
			# procd may return before the process has exited or its PID is removed.
			local pid attempt
			for attempt in 0 1 2 3 4 5 6 7 8 9 10; do
				pid=$(running_pid)
				if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
					break
				fi
				if [ "$attempt" -eq 10 ]; then
					job error stop_failed "等待进程退出超时，PID：$pid"; return 1;
				fi
				sleep 1
			done
			job success 'service_stopped';;
		*) job error 'action_unknown'; return 1;;
	esac
}

worker_exit() {
	rm -f "$RUN/check.log" "$RUN/service.log" "$RUN/validation.json"
	unlock
}
