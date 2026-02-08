#!/bin/bash
# Kill orphaned Chrome processes to prevent memory leaks
# Only kills processes older than 6 hours to avoid killing active sessions
# Run daily via cron

LOG_FILE="/var/log/chrome-cleanup.log"
DATE=$(date '+%Y-%m-%d %H:%M:%S')
MAX_AGE_SECONDS=21600  # 6 hours

KILLED=0
NOW=$(date +%s)

# Kill Chrome processes older than MAX_AGE_SECONDS
for pid in $(pgrep -f 'chrome' 2>/dev/null); do
    START_TIME=$(stat -c %Y /proc/$pid 2>/dev/null) || continue
    AGE=$((NOW - START_TIME))
    if [ $AGE -gt $MAX_AGE_SECONDS ]; then
        kill -9 $pid 2>/dev/null && ((KILLED++))
    fi
done

# Kill chrome-devtools-mcp processes older than MAX_AGE_SECONDS
for pid in $(pgrep -f 'chrome-devtools-mcp' 2>/dev/null); do
    START_TIME=$(stat -c %Y /proc/$pid 2>/dev/null) || continue
    AGE=$((NOW - START_TIME))
    if [ $AGE -gt $MAX_AGE_SECONDS ]; then
        kill -9 $pid 2>/dev/null && ((KILLED++))
    fi
done

# Clean up Chrome temp directories older than 1 day
CLEANED=$(find /tmp -maxdepth 1 -type d -name 'com.google.Chrome.*' -mtime +1 -exec rm -rf {} \; -print 2>/dev/null | wc -l)

# Purge chrome-chat-profile BrowserMetrics (can grow to 100GB+)
METRICS_DIR="/tmp/chrome-chat-profile/BrowserMetrics"
if [ -d "$METRICS_DIR" ]; then
    METRICS_SIZE=$(du -sh "$METRICS_DIR" 2>/dev/null | cut -f1)
    rm -rf "$METRICS_DIR"
    echo "[$DATE] Purged BrowserMetrics ($METRICS_SIZE)" >> "$LOG_FILE"
fi

# Purge chrome-debug-profile (used by Chrome DevTools MCP)
if [ -d "/tmp/chrome-debug-profile" ]; then
    DEBUG_SIZE=$(du -sh "/tmp/chrome-debug-profile" 2>/dev/null | cut -f1)
    rm -rf "/tmp/chrome-debug-profile"
    echo "[$DATE] Purged chrome-debug-profile ($DEBUG_SIZE)" >> "$LOG_FILE"
fi

REMAINING=$(pgrep -c -f 'chrome' 2>/dev/null || echo 0)

echo "[$DATE] Killed $KILLED old processes (>6h), cleaned $CLEANED temp dirs, $REMAINING Chrome processes still running" >> "$LOG_FILE"
