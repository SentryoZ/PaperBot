#!/usr/bin/env bash
# Download and run a PaperMC 26.2 server in offline mode, for testing bots.
#
# Requires Java 25. The system default `java` is 17 and will NOT work.
#   JAVA_BIN=/usr/lib/jvm/java-25-openjdk-amd64/bin/java ./scripts/paper-server.sh
set -euo pipefail

DIR="${PAPER_DIR:-$(cd "$(dirname "$0")/.." && pwd)/.paper-server}"
JAVA_BIN="${JAVA_BIN:-/usr/lib/jvm/java-25-openjdk-amd64/bin/java}"
PORT="${PAPER_PORT:-25577}"
BUILD="${PAPER_BUILD:-133}"
SHA="bf1dcf627364f8a631ab15250d240eb5a8e89faaac523b391e1c61367fce9ff1"
JAR_URL="https://fill-data.papermc.io/v1/objects/${SHA}/paper-26.2-${BUILD}.jar"

mkdir -p "$DIR"
cd "$DIR"

if [ ! -f paper.jar ]; then
  echo "Downloading Paper 26.2 build ${BUILD}..."
  curl -fL "$JAR_URL" -o paper.jar
fi

echo "eula=true" > eula.txt
cat > server.properties <<EOF
online-mode=false
server-port=${PORT}
motd=bot-test
view-distance=4
simulation-distance=4
spawn-protection=0
max-players=50
enable-command-block=true
EOF

echo "Starting Paper 26.2 on port ${PORT} (Ctrl+C to stop)..."
exec "$JAVA_BIN" -Xms512M -Xmx1500M -jar paper.jar --nogui
