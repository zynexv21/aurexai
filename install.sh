#!/bin/bash
# ============================================================
#   AUREX AI PANEL v1.0 — ONE-CLICK INSTALLER
#   Works on: Ubuntu, Debian, CentOS, AlmaLinux, Rocky,
#             Fedora, Amazon Linux + (any systemd distro)
#
#   USAGE (one-line on any VPS):
#     curl -sL <INSTALL_SCRIPT_URL> | bash -s -- \
#       GOOGLE_CLIENT_ID=xxx \
#       GOOGLE_CLIENT_SECRET=xxx \
#       AI_API_KEY=xxx \
#       AI_API_URL=https://api.deepseek.com/v1
# ============================================================

RED='\033[1;31m'; GREEN='\033[1;32m'; YELLOW='\033[1;33m'
CYAN='\033[1;36m'; MAGENTA='\033[1;35m'; WHITE='\033[1;37m'; BOLD='\033[1m'; NC='\033[0m'

# ═══════════════════════════════════════
#  CONFIG (edit me if needed)
# ═══════════════════════════════════════
REPO_URL="${REPO_URL:-https://github.com/zynexv21/aurexai/archive/refs/heads/main.tar.gz}"
INSTALL_DIR="/opt/aurex-ai-panel"
PORT=6867

show_logo() {
    clear
    echo ""
    echo -e "${CYAN}"
    cat << "LOGO"

     █████╗ ███████╗██╗   ██╗████████╗██████╗  █████╗ ██╗   ██╗
    ██╔══██╗██╔════╝██║   ██║╚══██╔══╝██╔══██╗██╔══██╗╚██╗ ██╔╝
    ███████║█████╗  ██║   ██║   ██║   ██████╔╝███████║ ╚████╔╝
    ██╔══██║██╔══╝  ██║   ██║   ██║   ██╔══██╗██╔══██║  ╚██╔╝
    ██║  ██║███████╗╚██████╔╝   ██║   ██║  ██║██║  ██║   ██║
    ╚═╝  ╚═╝╚══════╝ ╚═════╝    ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝
                          ██╗ █████╗
                          ██║██╔══██╗
                          ██║███████║
                     ██   ██║██╔══██║
                     ╚█████╔╝██║  ██║
                      ╚════╝ ╚═╝  ╚═╝
LOGO
    echo -e "${NC}"
    echo -e "${WHITE}${BOLD}      ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${MAGENTA}${BOLD}         AUREX AI PANEL • INSTALLER v1.0${NC}"
    echo -e "${WHITE}${BOLD}      ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}

# ═══════════════════════════════════════
#  HELPERS
# ═══════════════════════════════════════
log()  { echo -e "$@"; }
ok()   { echo -e "    ${GREEN}${BOLD}✓${NC} $1"; }
info() { echo -e "    ${CYAN}•${NC} $1"; }
warn() { echo -e "    ${YELLOW}!${NC} $1"; }
fail() { echo -e "    ${RED}✗ $1${NC}"; }

step() { echo -e "  ${YELLOW}[${1}/${2}]${NC} ${3}"; }

detect_pkg() {
    if command -v apt-get &>/dev/null; then PM="apt"
    elif command -v dnf &>/dev/null; then PM="dnf"
    elif command -v yum &>/dev/null; then PM="yum"
    else PM="none"; fi
}

pkg_update() {
    case $PM in
        apt) apt-get update -y >/dev/null 2>&1 ;;
        dnf) dnf check-update >/dev/null 2>&1 ;;
        yum) yum check-update >/dev/null 2>&1 ;;
    esac
}

pkg_install() {
    case $PM in
        apt) apt-get install -y "$@" >/dev/null 2>&1 ;;
        dnf) dnf install -y "$@" >/dev/null 2>&1 ;;
        yum) yum install -y "$@" >/dev/null 2>&1 ;;
    esac
}

# ═══════════════════════════════════════
#  NODE.JS INSTALL (cross-distro)
# ═══════════════════════════════════════
install_node() {
    if command -v node &>/dev/null && node -v 2>/dev/null | grep -qE "v(1[89]|[2-9][0-9])\."; then
        ok "Node.js $(node -v) already installed"
        return 0
    fi
    info "Installing Node.js 20 LTS..."
    case $PM in
        apt)
            curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
            apt-get install -y nodejs >/dev/null 2>&1 ;;
        dnf)
            curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
            dnf install -y nodejs >/dev/null 2>&1 ;;
        yum)
            curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
            yum install -y nodejs >/dev/null 2>&1 ;;
    esac
    if command -v node &>/dev/null; then
        ok "Node.js $(node -v) installed"
    else
        fail "Node.js install failed. Installing manually..."
        curl -fsSL https://nodejs.org/dist/v20.11.1/node-v20.11.1-linux-x64.tar.xz | tar -xJ -C /usr/local --strip-components=1 >/dev/null 2>&1
        ln -sf /usr/local/bin/node /usr/bin/node
        ln -sf /usr/local/bin/npm /usr/bin/npm
        command -v node &>/dev/null && ok "Node.js $(node -v) installed" || fail "Node.js FAILED. Check internet connection and retry."
    fi
}

# ═══════════════════════════════════════
#  CLOUDFLARED INSTALL (binary - works everywhere)
# ═══════════════════════════════════════
install_cloudflared() {
    if command -v cloudflared &>/dev/null; then
        ok "cloudflared already installed"
        return 0
    fi
    info "Installing cloudflared (Cloudflare Tunnel)..."
    local ARCH=$(uname -m)
    case $ARCH in
        x86_64)  URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" ;;
        aarch64|arm64) URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64" ;;
        armv7l)  URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm" ;;
        *)       URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" ;;
    esac
    curl -fsSL "$URL" -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared
    if command -v cloudflared &>/dev/null; then
        ok "cloudflared installed: $(cloudflared --version 2>/dev/null | head -1)"
    else
        warn "cloudflared binary failed. Trying package manager..."
        pkg_install cloudflared
        command -v cloudflared &>/dev/null && ok "cloudflared installed" || warn "cloudflared not installed — tunnel will be skipped."
    fi
}

# ═══════════════════════════════════════
#  CLOUDFLARE TUNNEL (systemd service + URL)
# ═══════════════════════════════════════
create_tunnel_service() {
    cat > /etc/systemd/system/aurex-tunnel.service << EOF
[Unit]
Description=Aurex AI Cloudflare Tunnel
After=network.target aurex-ai.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash $INSTALL_DIR/scripts/start-tunnel.sh
ExecStop=/usr/bin/pkill -f "cloudflared tunnel --url" || true
User=root

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload >/dev/null 2>&1
    systemctl enable aurex-tunnel >/dev/null 2>&1
}

# ═══════════════════════════════════════
#  MAIN INSTALL
# ═══════════════════════════════════════
install_panel() {
    # ── parse passed env vars (from bash -s -- KEY=VAL)
    for arg in "$@"; do
        case "$arg" in
            GOOGLE_CLIENT_ID=*|GOOGLE_CLIENT_SECRET=*|AI_API_KEY=*|AI_API_URL=*|AI_MODEL=*|AI_MAX_TOKENS=*|PORT=*|SESSION_SECRET=*|REPO_URL=*)
                export "$arg" ;;
        esac
    done

    log "\n  ${CYAN}${BOLD}════════════════════════════════════════${NC}"
    log "  ${WHITE}${BOLD}   INSTALLING AUREX AI PANEL${NC}"
    log "  ${CYAN}${BOLD}════════════════════════════════════════${NC}\n"

    detect_pkg
    [ "$PM" = "none" ] && { fail "No supported package manager found!"; return 1; }
    info "Package manager: $PM | OS: $(uname -sr)"

    step 1 8 "System update"
    pkg_update

    step 2 8 "Installing base tools"
    pkg_install curl wget git tar openssl
    ok "Base tools ready"

    step 3 8 "Installing Node.js"
    install_node

    step 4 8 "Creating project structure"
    mkdir -p "$INSTALL_DIR"/{public/pages,data,logs,scripts}
    ok "Structure ready at $INSTALL_DIR"

    step 5 8 "Downloading project files"
    SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
    if [ -n "$(find "$SCRIPT_DIR" -maxdepth 1 -name server.js 2>/dev/null)" ]; then
        # running from local copy
        info "Copying from local directory: $SCRIPT_DIR"
        cp -r "$SCRIPT_DIR"/. "$INSTALL_DIR"/
    else
        # running via curl | bash → fetch from GitHub
        info "Fetching from GitHub: $REPO_URL"
        curl -fsSL "$REPO_URL" -o /tmp/aurex-panel.tar.gz || { fail "Download failed — check REPO_URL in the script."; return 1; }
        mkdir -p /tmp/aurex-extract
        tar -xzf /tmp/aurex-panel.tar.gz -C /tmp/aurex-extract --strip-components=1
        cp -r /tmp/aurex-extract/. "$INSTALL_DIR"/
        rm -rf /tmp/aurex-extract /tmp/aurex-panel.tar.gz
    fi
    rm -rf "$INSTALL_DIR/.env" "$INSTALL_DIR/node_modules" 2>/dev/null
    ok "Project files ready"
    sleep 1

    step 6 8 "Installing npm packages"
    cd "$INSTALL_DIR"
    npm install --prefix "$INSTALL_DIR" --no-audit --no-fund >/dev/null 2>&1 &
    NPM_PID=$!
    while kill -0 $NPM_PID 2>/dev/null; do sleep 1; done
    [ -d "$INSTALL_DIR/node_modules" ] && ok "npm packages installed" || fail "npm install failed — run 'cd $INSTALL_DIR && npm install' manually"
    sleep 1

    step 7 8 "Configuring environment (.env)"
    generate_env
    ok "Configuration written (secrets stay on this server only)"

    step 8 8 "Starting services"
    create_systemd_service
    systemctl daemon-reload
    systemctl enable aurex-ai >/dev/null 2>&1
    systemctl start aurex-ai
    sleep 2

    if systemctl is-active aurex-ai >/dev/null 2>&1; then
        ok "Panel service running"
        install_cloudflared
        create_tunnel_scripts
        create_tunnel_service
        systemctl start aurex-tunnel
        echo ""
        log "  ${GREEN}${BOLD}═══════════════════════════════════════════════════${NC}"
        log "  ${GREEN}${BOLD}      ✓ AUREX AI PANEL INSTALLED SUCCESSFULLY!${NC}"
        log "  ${GREEN}${BOLD}═══════════════════════════════════════════════════${NC}"
        echo ""
        log "  ${WHITE}${BOLD}Local URL:${NC}  ${CYAN}http://localhost:$PORT${NC}"
        log "  ${WHITE}${BOLD}Port:${NC}       ${CYAN}$PORT${NC}"
        show_tunnel_url
        echo ""
        log "  ${WHITE}${BOLD}Manage commands:${NC}"
        log "  ${CYAN}    systemctl start|stop|restart aurex-ai${NC}"
        log "  ${CYAN}    journalctl -u aurex-ai -f${NC}"
        log "  ${CYAN}    bash $INSTALL_DIR/scripts/start-tunnel.sh  (reconnect tunnel)${NC}"
        echo ""
        log "  ${MAGENTA}${BOLD}Open the Public URL above → press 1 (Install) is done →${NC}"
        log "  ${WHITE}    Google login karne ke liye oauth URL confirm karo${NC}"
        echo ""
    else
        fail "Panel failed to start. Check logs: journalctl -u aurex-ai -e"
        log "  → Try manual start: cd $INSTALL_DIR && node server.js"
    fi
}

# ═══════════════════════════════════════
#  ENV GENERATION (keys via env or prompt — never in repo)
# ═══════════════════════════════════════
generate_env() {
    ENV_FILE="$INSTALL_DIR/.env"

    G_ID="${GOOGLE_CLIENT_ID:-}"; G_SEC="${GOOGLE_CLIENT_SECRET:-}"
    A_KEY="${AI_API_KEY:-}"; A_URL="${AI_API_URL:-https://api.deepseek.com/v1}"; A_MODEL="${AI_MODEL:-deepseek-chat}"

    if [ -z "$G_ID" ] || [ -z "$G_SEC" ]; then
        warn "Google OAuth keys not passed. Fill them now (or press Enter to skip → demo mode):"
        [ -z "$G_ID" ]  && { read -rp "    Google Client ID:    " G_ID; }
        [ -z "$G_SEC" ] && { read -rsp "    Google Client Secret: " G_SEC; echo; }
    fi

    if [ -z "$A_KEY" ]; then
        warn "AI API key not passed. Fill now (or press Enter for demo mode):"
        read -rp "    AI API Key (DeepSeek/OpenAI): " A_KEY
    fi
    [ -z "$A_MODEL" ] && A_MODEL="deepseek-chat"
    [ -z "$A_URL" ] && A_URL="https://api.deepseek.com/v1"
    SESS_SEC="${SESSION_SECRET:-$(openssl rand -hex 32)}"

    cat > "$ENV_FILE" << EOF
# AUREX AI PANEL — generated by install.sh
PORT=$PORT
SESSION_SECRET=$SESS_SEC
GOOGLE_CLIENT_ID=$G_ID
GOOGLE_CLIENT_SECRET=$G_SEC
CALLBACK_URL=/auth/google/callback
AI_API_KEY=$A_KEY
AI_MODEL=$A_MODEL
AI_API_URL=$A_URL
AI_MAX_TOKENS=${AI_MAX_TOKENS:-2000}
EOF
}

# ═══════════════════════════════════════
#  SYSTEMD SERVICE
# ═══════════════════════════════════════
create_systemd_service() {
    NODE_BIN="$(command -v node)"
    [ -z "$NODE_BIN" ] && NODE_BIN="/usr/bin/node"
    cat > /etc/systemd/system/aurex-ai.service << EOF
[Unit]
Description=Aurex AI Panel
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=$PORT

[Install]
WantedBy=multi-user.target
EOF
}

# ═══════════════════════════════════════
#  TUNNEL URL DISPLAY / START SCRIPT
# ═══════════════════════════════════════
create_tunnel_scripts() {
    cat > "$INSTALL_DIR/scripts/start-tunnel.sh" << 'EOF'
#!/bin/bash
# Start Cloudflare quick tunnel to the panel and print/save the public URL
INSTALL_DIR="/opt/aurex-ai-panel"
PORT=6867
LOG="$INSTALL_DIR/logs/tunnel.log"
URL_FILE="$INSTALL_DIR/logs/tunnel-url.txt"

pkill -f "cloudflared tunnel --url" 2>/dev/null
rm -f "$LOG"
nohup cloudflared tunnel --url "http://localhost:$PORT" > "$LOG" 2>&1 &

for i in $(seq 1 20); do
    URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" 2>/dev/null | head -1)
    [ -n "$URL" ] && break
    sleep 1
done

if [ -n "$URL" ]; then
    echo "$URL" > "$URL_FILE"
    echo ""
    echo "  -----------------------------------------------------"
    echo "   PUBLIC URL:  $URL"
    echo "  -----------------------------------------------------"
    echo "   (URL file: $URL_FILE — run this script anytime to get a new link)"
    echo ""
else
    echo "  Tunnel URL not ready yet. Check: $LOG"
fi
EOF
    chmod +x "$INSTALL_DIR/scripts/start-tunnel.sh"
}

show_tunnel_url() {
    if [ -f "$INSTALL_DIR/scripts/start-tunnel.sh" ]; then
        bash "$INSTALL_DIR/scripts/start-tunnel.sh"
    fi
}

# ═══════════════════════════════════════
#  MANAGEMENT MENU
# ═══════════════════════════════════════
show_menu() {
    log "  ${CYAN}${BOLD}┌────────────────────────────────────┐${NC}"
    log "  ${CYAN}${BOLD}│  ${WHITE}${BOLD}[1]${CYAN}  Install Aurex AI Panel     ${NC}${CYAN}${BOLD}│${NC}"
    log "  ${CYAN}${BOLD}│  ${WHITE}${BOLD}[2]${CYAN}  Update Panel               ${NC}${CYAN}${BOLD}│${NC}"
    log "  ${CYAN}${BOLD}│  ${WHITE}${BOLD}[3]${CYAN}  Start Panel                ${NC}${CYAN}${BOLD}│${NC}"
    log "  ${CYAN}${BOLD}│  ${WHITE}${BOLD}[4]${CYAN}  Stop Panel                 ${NC}${CYAN}${BOLD}│${NC}"
    log "  ${CYAN}${BOLD}│  ${WHITE}${BOLD}[5]${CYAN}  Restart Panel              ${NC}${CYAN}${BOLD}│${NC}"
    log "  ${CYAN}${BOLD}│  ${WHITE}${BOLD}[6]${CYAN}  Tunnel Link                ${NC}${CYAN}${BOLD}│${NC}"
    log "  ${CYAN}${BOLD}│  ${WHITE}${BOLD}[7]${CYAN}  View Logs                  ${NC}${CYAN}${BOLD}│${NC}"
    log "  ${CYAN}${BOLD}│  ${WHITE}${BOLD}[8]${CYAN}  Uninstall                  ${NC}${CYAN}${BOLD}│${NC}"
    log "  ${CYAN}${BOLD}│  ${WHITE}${BOLD}[9]${CYAN}  Exit                       ${NC}${CYAN}${BOLD}│${NC}"
    log "  ${CYAN}${BOLD}└────────────────────────────────────┘${NC}"
    log ""
    read -rp "  ━▶ Enter your choice [1-9]: " choice
    case $choice in
        1) install_panel ;;
        2) systemctl restart aurex-ai && ok "Panel updated & restarted" ;;
        3) systemctl start aurex-ai && ok "Panel started on port $PORT" ;;
        4) systemctl stop aurex-ai && warn "Panel stopped" ;;
        5) systemctl restart aurex-ai && ok "Panel restarted" ;;
        6) bash "$INSTALL_DIR/scripts/start-tunnel.sh" ;;
        7) journalctl -u aurex-ai -f --no-pager ;;
        8) uninstall_panel ;;
        9) log "\n  ${CYAN}${BOLD}Thanks for using Aurex AI!${NC}\n"; exit 0 ;;
        *) fail "Invalid option" ;;
    esac
}

uninstall_panel() {
    warn "Uninstalling... confirm [y/N]"
    read -r c
    [ "$c" = "y" ] || { log "Cancelled"; return; }
    systemctl stop aurex-ai aurex-tunnel 2>/dev/null
    systemctl disable aurex-ai aurex-tunnel 2>/dev/null
    rm -f /etc/systemd/system/aurex-ai.service /etc/systemd/system/aurex-tunnel.service
    systemctl daemon-reload
    pkill -f cloudflared 2>/dev/null
    rm -rf "$INSTALL_DIR"
    ok "Aurex AI Panel removed"
}

# ═══════════════════════════════════════
#  ENTRY
# ═══════════════════════════════════════
show_logo

# If called with args (curl | bash -s -- KEY=VAL) → install directly
if [ $# -gt 0 ]; then
    install_panel "$@"
    exit $?
fi

# Also auto-install if install.sh was piped in without a repo copy and no local server.js
SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
if [ ! -f "$SCRIPT_DIR/server.js" ]; then
    log "  ${YELLOW}Running one-click mode...${NC}"
    install_panel
    exit $?
fi

create_tunnel_scripts
while true; do show_menu; log ""; done