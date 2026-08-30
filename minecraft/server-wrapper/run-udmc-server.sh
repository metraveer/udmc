#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"

JAVA="${JAVA:-java}"
SERVER_JAR="${SERVER_JAR:-fabric-server-launch.jar}"
MAX_MEMORY="${MAX_MEMORY:-4G}"
RESTART_MARKER="udmc-sync/restart-requested"

while true; do
  rm -f "$RESTART_MARKER"
  status=0
  "$JAVA" -Xms1G -Xmx"$MAX_MEMORY" -jar "$SERVER_JAR" nogui || status=$?

  if [ -f "udmc-sync/agent-update/task.properties" ]; then
    "$JAVA" -Xmx48m -cp "udmc-sync/agent-update/helper.jar" dev.udmc.sync.update.AgentUpdateHelper --finish "udmc-sync/agent-update/task.properties"
  fi

  if [ ! -f "$RESTART_MARKER" ]; then
    exit "$status"
  fi
done
