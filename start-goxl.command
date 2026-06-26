#!/bin/bash
# ─────────────────────────────────────────────
#  Go XL — Servidor de Desenvolvimento
#  Dê duplo clique neste arquivo para iniciar
# ─────────────────────────────────────────────

# Vai para a pasta do projeto
cd "$(dirname "$0")"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║       GO XL — Dev Server             ║"
echo "╚══════════════════════════════════════╝"
echo ""

# Mostra o IP da máquina para saber qual endereço usar nos celulares
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
echo "📱 IP do Mac na rede: $IP"
echo "   Os celulares devem estar no mesmo WiFi!"
echo ""
echo "🚀 Iniciando Metro Bundler..."
echo "   (pressione Ctrl+C para parar o servidor)"
echo ""

# Inicia o Expo em modo LAN
npx expo start --lan
