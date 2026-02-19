#!/usr/bin/env bash
# server/setup.sh — downloads PaperMC 1.8.9, installs deps, verifies Java
# Debian-optimized version

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
JAR_PATH="$SCRIPT_DIR/paper-1.8.9.jar"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " MC 1.8 PvP Boxing Trainer — Setup (Debian)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Check if running as root ───────────────────────────────────────────────
if [ "$EUID" -eq 0 ]; then 
  echo "WARNING: Running as root. Consider creating a dedicated user:"
  echo "  sudo useradd -m -s /bin/bash mctrainer"
  echo "  sudo su - mctrainer"
  echo ""
  read -p "Continue anyway? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

# ── System dependencies ─────────────────────────────────────────────────────
echo ""
echo "Checking system dependencies..."

# Check if we need to install anything
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

# Install missing dependencies if any
if [ ${#MISSING_DEPS[@]} -gt 0 ]; then
  echo "Missing dependencies: ${MISSING_DEPS[*]}"
  echo ""
  
  if [ "$EUID" -ne 0 ]; then
    echo "Installation requires sudo. Run:"
    echo "  sudo apt update"
    echo "  sudo apt install -y ${MISSING_DEPS[*]}"
    echo ""
    read -p "Install now? (requires sudo) (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      sudo apt update
      sudo apt install -y "${MISSING_DEPS[@]}"
    else
      echo "Please install dependencies manually and re-run this script."
      exit 1
    fi
  else
    apt update
    apt install -y "${MISSING_DEPS[@]}"
  fi
fi

# ── Java ────────────────────────────────────────────────────────────────────
echo ""
echo "Checking Java..."
JAVA_VER=$(java -version 2>&1 | awk -F '"' '/version/ {print $2}')
JAVA_MAJOR=$(echo "$JAVA_VER" | cut -d'.' -f1)

# Handle both old (1.8.x) and new (17+) version formats
if [[ "$JAVA_VER" == 1.* ]]; then
  JAVA_MAJOR=$(echo "$JAVA_VER" | cut -d'.' -f2)
fi

if [ "$JAVA_MAJOR" -lt 8 ]; then
  echo "ERROR: Java 8+ required, found $JAVA_VER"
  echo "Install with: sudo apt install openjdk-17-jdk"
  exit 1
fi

echo "  Java $JAVA_VER  ✓"

# Set JAVA_HOME if not set (common issue on Debian)
if [ -z "${JAVA_HOME:-}" ]; then
  JAVA_HOME=$(dirname $(dirname $(readlink -f $(which java))))
  export JAVA_HOME
  echo "  Set JAVA_HOME=$JAVA_HOME"
  
  # Suggest adding to profile
  echo ""
  echo "  Consider adding to ~/.bashrc or ~/.profile:"
  echo "    export JAVA_HOME=$JAVA_HOME"
fi

# ── Node.js ─────────────────────────────────────────────────────────────────
echo ""
echo "Checking Node.js..."
NODE_VER=$(node --version | tr -d 'v')
NODE_MAJOR=$(echo "$NODE_VER" | cut -d'.' -f1)

if [ "$NODE_MAJOR" -lt 14 ]; then
  echo "WARNING: Node.js $NODE_VER detected. Node 18+ recommended."
  echo ""
  echo "To install Node 18 LTS on Debian:"
  echo "  curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -"
  echo "  sudo apt install -y nodejs"
  echo ""
  read -p "Continue with Node $NODE_VER anyway? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

echo "  Node v$NODE_VER  ✓"

# ── PaperMC 1.8.9 ───────────────────────────────────────────────────────────
echo ""
if [ -f "$JAR_PATH" ]; then
  echo "Server jar already exists  ✓"
else
  echo "Downloading PaperMC 1.8.9..."
  
  # Use Paper API to get latest build
  PAPER_API="https://api.papermc.io/v2/projects/paper/versions/1.8.9"
  
  if command -v curl &> /dev/null; then
    BUILD=$(curl -s "$PAPER_API" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['builds'][-1])" 2>/dev/null || echo "445")
    URL="${PAPER_API}/builds/${BUILD}/downloads/paper-1.8.9-${BUILD}.jar"
    curl -L -o "$JAR_PATH" "$URL" --progress-bar || {
      echo "ERROR: Download failed. Check internet connection."
      exit 1
    }
  elif command -v wget &> /dev/null; then
    BUILD=$(wget -qO- "$PAPER_API" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['builds'][-1])" 2>/dev/null || echo "445")
    URL="${PAPER_API}/builds/${BUILD}/downloads/paper-1.8.9-${BUILD}.jar"
    wget -O "$JAR_PATH" "$URL" || {
      echo "ERROR: Download failed. Check internet connection."
      exit 1
    }
  fi
  
  # Verify download
  if [ ! -f "$JAR_PATH" ] || [ ! -s "$JAR_PATH" ]; then
    echo "ERROR: Download failed or file is empty"
    exit 1
  fi
  
  echo "  Downloaded build ${BUILD}  ✓"
fi

# ── npm install ──────────────────────────────────────────────────────────────
echo ""
echo "Installing Node.js dependencies..."
cd "$PROJECT_DIR"

# Clean install to avoid issues
rm -rf node_modules package-lock.json 2>/dev/null || true

npm install || {
  echo "ERROR: npm install failed"
  echo "Try: sudo npm install -g npm@latest"
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

# Set proper permissions
chmod 755 "$SCRIPT_DIR/instance" "$SCRIPT_DIR/play_instance" "$PROJECT_DIR/weights"

echo "  ✓"

# ── Firewall configuration ──────────────────────────────────────────────────
echo ""
echo "Firewall configuration..."

if command -v ufw &> /dev/null && sudo ufw status | grep -q "Status: active"; then
  echo "  UFW firewall detected."
  echo "  Training server (local only): port 25570 - no action needed"
  echo "  Play server (LAN access): port 25565"
  echo ""
  read -p "  Open port 25565 for LAN play? (y/N) " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    sudo ufw allow 25565/tcp comment "Minecraft PvP Trainer"
    echo "    Port 25565 opened  ✓"
  fi
elif command -v iptables &> /dev/null; then
  echo "  iptables detected. To allow LAN connections manually:"
  echo "    sudo iptables -A INPUT -p tcp --dport 25565 -j ACCEPT"
  echo "    sudo iptables-save > /etc/iptables/rules.v4"
else
  echo "  No firewall detected  ✓"
fi

# ── System resource check ───────────────────────────────────────────────────
echo ""
echo "System resources..."

# RAM check
TOTAL_RAM=$(free -g | awk '/^Mem:/{print $2}')
if [ "$TOTAL_RAM" -lt 4 ]; then
  echo "  WARNING: Only ${TOTAL_RAM}GB RAM detected. 8GB+ recommended."
  echo "  Consider reducing PARALLEL_ZONES in config.js"
fi

# CPU check
CPU_CORES=$(nproc)
echo "  CPU cores: $CPU_CORES"
if [ "$CPU_CORES" -lt 4 ]; then
  echo "  WARNING: Only $CPU_CORES cores. 4+ recommended for training."
fi

echo "  RAM: ${TOTAL_RAM}GB"

# ── Performance tuning suggestions ──────────────────────────────────────────
echo ""
echo "Performance tuning suggestions:"
echo ""
echo "1. Increase file descriptor limit (add to /etc/security/limits.conf):"
echo "     $USER  soft  nofile  65536"
echo "     $USER  hard  nofile  65536"
echo ""
echo "2. Optimize network (add to /etc/sysctl.conf):"
echo "     net.ipv4.tcp_fin_timeout = 30"
echo "     net.ipv4.tcp_keepalive_time = 300"
echo "     net.core.somaxconn = 2048"
echo "   Apply with: sudo sysctl -p"
echo ""

# ── Create systemd service (optional) ───────────────────────────────────────
read -p "Create systemd service for auto-start? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  SERVICE_FILE="/etc/systemd/system/mcpvp-trainer.service"
  
  sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=Minecraft PvP AI Trainer
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$PROJECT_DIR
ExecStart=/usr/bin/node src/train.js
Restart=on-failure
RestartSec=10
StandardOutput=append:$PROJECT_DIR/logs/trainer.log
StandardError=append:$PROJECT_DIR/logs/trainer-error.log

# Resource limits
LimitNOFILE=65536
MemoryMax=5G

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  echo ""
  echo "  Systemd service created!"
  echo "  Enable: sudo systemctl enable mcpvp-trainer"
  echo "  Start:  sudo systemctl start mcpvp-trainer"
  echo "  Status: sudo systemctl status mcpvp-trainer"
  echo "  Logs:   journalctl -u mcpvp-trainer -f"
fi

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Setup complete!"
echo ""
echo " Train the AI (runs 1 server with 8 zones):"
echo "   npm run train"
echo ""
echo " Resume a previous run:"
echo "   npm run train -- --resume"
echo ""
echo " Fight the AI with your MC 1.8 client:"
echo "   npm run play"
echo "   Connect to: 127.0.0.1:25565 (local)"
echo ""
echo " Connect from another machine on your LAN:"
echo "   Find your IP: ip addr show | grep 'inet '"
echo "   Connect to: <YOUR_IP>:25565"
echo ""
echo " Monitoring:"
echo "   Logs: tail -f logs/*.log"
echo "   Resources: htop"
echo ""
echo " Notes:"
echo "   - Training server: port 25570 (localhost only)"
echo "   - Play server: port 25565 (LAN accessible)"
echo "   - Both can run simultaneously"
echo "   - Champion saves to weights/champion.json"
echo "   - Adjust JAVA_FLAGS in config.js if low on RAM"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"