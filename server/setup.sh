#!/usr/bin/env bash
# server/setup.sh — downloads PaperMC 1.8.8, installs deps, verifies Java

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
JAR_PATH="$SCRIPT_DIR/paper-1.8.8.jar"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " MC 1.8 PvP Boxing Trainer — Setup (Debian)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

echo ""
echo "Project directory: $PROJECT_DIR"
echo "Script directory:  $SCRIPT_DIR"
echo ""

# ── Validate project structure ─────────────────────────────────────────────
if [ ! -f "$PROJECT_DIR/package.json" ]; then
  echo "ERROR: package.json not found in $PROJECT_DIR"
  echo ""
  echo "Please ensure you're running this from the correct directory."
  exit 1
fi

# ── Check if running as root ───────────────────────────────────────────────
if [ "$EUID" -eq 0 ]; then 
  echo "WARNING: Running as root. Consider creating a dedicated user."
  read -p "Continue anyway? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

# ── System dependencies ─────────────────────────────────────────────────────
echo ""
echo "Checking system dependencies..."

MISSING_DEPS=()

if ! command -v java &> /dev/null; then
  MISSING_DEPS+=("openjdk-17-jdk")
fi

if ! command -v node &> /dev/null; then
  MISSING_DEPS+=("nodejs")
fi

if ! command -v npm &> /dev/null; then
  MISSING_DEPS+=("npm")
fi

if ! command -v curl &> /dev/null && ! command -v wget &> /dev/null; then
  MISSING_DEPS+=("curl")
fi

if ! command -v python3 &> /dev/null; then
  MISSING_DEPS+=("python3")
fi

if [ ${#MISSING_DEPS[@]} -gt 0 ]; then
  echo "Missing dependencies: ${MISSING_DEPS[*]}"
  echo ""
  
  if [ "$EUID" -ne 0 ]; then
    echo "Installation requires sudo:"
    echo "  sudo apt update"
    echo "  sudo apt install -y ${MISSING_DEPS[*]}"
    echo ""
    read -p "Install now? (requires sudo) (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      sudo apt update
      sudo apt install -y "${MISSING_DEPS[@]}"
    else
      echo "Please install dependencies manually and re-run."
      exit 1
    fi
  else
    apt update
    apt install -y "${MISSING_DEPS[@]}"
  fi
fi

echo "  All dependencies present ✓"

# ── Java ────────────────────────────────────────────────────────────────────
echo ""
echo "Checking Java..."
JAVA_VER=$(java -version 2>&1 | awk -F '"' '/version/ {print $2}')
JAVA_MAJOR=$(echo "$JAVA_VER" | cut -d'.' -f1)

if [[ "$JAVA_VER" == 1.* ]]; then
  JAVA_MAJOR=$(echo "$JAVA_VER" | cut -d'.' -f2)
fi

if [ "$JAVA_MAJOR" -lt 8 ]; then
  echo "ERROR: Java 8+ required, found $JAVA_VER"
  exit 1
fi

echo "  Java $JAVA_VER  ✓"

# ── Node.js ─────────────────────────────────────────────────────────────────
echo ""
echo "Checking Node.js..."
NODE_VER=$(node --version | tr -d 'v')
NODE_MAJOR=$(echo "$NODE_VER" | cut -d'.' -f1)

if [ "$NODE_MAJOR" -lt 14 ]; then
  echo "WARNING: Node.js $NODE_VER detected. Node 18+ recommended."
fi

echo "  Node v$NODE_VER  ✓"

# ── PaperMC 1.8.8 build 445 ────────────────────────────────────────────────
echo ""
if [ -f "$JAR_PATH" ]; then
  echo "Server jar already exists  ✓"
else
  echo "Downloading PaperMC 1.8.8 (build 445)..."

  PAPER_BUILD=445
  PAPER_SHA256="7ff6d2cec671ef0d95b3723b5c92890118fb882d73b7f8fa0a2cd31d97c55f86"
  URL="https://api.papermc.io/v2/projects/paper/versions/1.8.8/builds/${PAPER_BUILD}/downloads/paper-1.8.8-${PAPER_BUILD}.jar"

  if command -v curl &> /dev/null; then
    curl -L -o "$JAR_PATH" "$URL" --progress-bar || {
      echo "ERROR: Download failed. Place paper-1.8.8.jar at $JAR_PATH manually."
      exit 1
    }
  elif command -v wget &> /dev/null; then
    wget -O "$JAR_PATH" "$URL" || {
      echo "ERROR: Download failed. Place paper-1.8.8.jar at $JAR_PATH manually."
      exit 1
    }
  fi

  # Verify checksum
  ACTUAL_SHA=$(sha256sum "$JAR_PATH" | awk '{print $1}')
  if [ "$ACTUAL_SHA" != "$PAPER_SHA256" ]; then
    echo "ERROR: SHA256 mismatch — expected $PAPER_SHA256, got $ACTUAL_SHA"
    rm -f "$JAR_PATH"
    exit 1
  fi

  echo "  Downloaded PaperMC 1.8.8 build ${PAPER_BUILD}  ✓"
fi

# ── npm install ──────────────────────────────────────────────────────────────
echo ""
echo "Installing Node.js dependencies..."
cd "$PROJECT_DIR"

if [ ! -f "package.json" ]; then
  echo "ERROR: package.json not found after cd to $PROJECT_DIR"
  exit 1
fi

rm -rf node_modules package-lock.json 2>/dev/null || true

npm install || {
  echo "ERROR: npm install failed"
  exit 1
}
echo "  ✓"

# ── Create directories ──────────────────────────────────────────────────────
echo ""
echo "Creating directories..."
mkdir -p "$SCRIPT_DIR/instance"
mkdir -p "$SCRIPT_DIR/play_instance"
mkdir -p "$PROJECT_DIR/weights"
mkdir -p "$PROJECT_DIR/logs"

echo "  ✓"

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Setup complete!"
echo ""
echo " Train the AI:"
echo "   npm run train"
echo ""
echo " Resume training:"
echo "   npm run train -- --resume"
echo ""
echo " Fight the AI:"
echo "   npm run play"
echo "   Connect to: 127.0.0.1:25565"
echo ""
echo " Notes:"
echo "   - Training server: port 25570 (localhost only)"
echo "   - Play server: port 25565 (LAN accessible)"
echo "   - Champion saves to weights/champion.json"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"