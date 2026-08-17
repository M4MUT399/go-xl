#!/bin/zsh
# salvar_chave.sh — guarda a chave do Stripe no supabase/scripts/.env, uma vez só.
#
# Por que existe: passar a chave pelo clipboard a cada comando é frágil — copiar
# qualquer outra coisa no meio do caminho (inclusive o próprio comando) apaga a
# chave. Aqui ela é gravada uma vez no .env, que já está no .gitignore, e os
# comandos seguintes não dependem mais do que está copiado.
#
#   ./salvar_chave.sh
#
# A chave vem do clipboard, é validada antes de qualquer coisa, e nunca é
# exibida na tela.

ENV_FILE=/Users/mamute99/go-xl/supabase/scripts/.env

CHAVE="$(pbpaste)"

case "$CHAVE" in
  rk_live_*|sk_live_*) ;;
  *)
    echo "──────────────────────────────────────────────────────────"
    echo "PAREI: o que está copiado não é uma chave do Stripe."
    echo "Começa com: $(echo "$CHAVE" | head -c 12)…"
    echo "Tamanho: ${#CHAVE} caracteres  (a chave tem ~107)"
    echo ""
    echo "Nada foi gravado."
    echo "──────────────────────────────────────────────────────────"
    exit 1
    ;;
esac

if [ ${#CHAVE} -lt 60 ]; then
  echo "PAREI: começa certo mas está curta demais (${#CHAVE} caracteres)."
  echo "Provavelmente é a versão mascarada, não a chave inteira. Nada foi gravado."
  exit 1
fi

# Remove qualquer resquício: linha solta com o valor cru e chaves antigas.
grep -v '^rk_live_' "$ENV_FILE" | grep -v '^sk_live_' | grep -v '^STRIPE_SECRET_KEY=' > "$ENV_FILE.tmp"
printf 'STRIPE_SECRET_KEY=%s\n' "$CHAVE" >> "$ENV_FILE.tmp"
mv "$ENV_FILE.tmp" "$ENV_FILE"

echo "✅ Chave guardada em supabase/scripts/.env (${#CHAVE} caracteres)."
echo "   A partir de agora os comandos não dependem mais do clipboard."
