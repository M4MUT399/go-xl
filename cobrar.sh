#!/bin/zsh
# cobrar.sh — atalho para cobrar a tarifa de uma corrida que rodou sem cobrança.
#
#   ./cobrar.sh        → só MOSTRA o que seria cobrado (não cobra nada)
#   ./cobrar.sh sim    → cobra de verdade
#
# A chave do Stripe vem de supabase/scripts/.env (gravada uma vez por
# salvar_chave.sh). O clipboard não é mais usado para nada: copiar qualquer
# coisa no meio do caminho deixou de quebrar o comando.

cd /Users/mamute99/go-xl || exit 1

if ! grep -q '^STRIPE_SECRET_KEY=' supabase/scripts/.env 2>/dev/null; then
  echo "──────────────────────────────────────────────────────────"
  echo "PAREI: não achei a chave do Stripe em supabase/scripts/.env."
  echo ""
  echo "Copie a chave no Stripe e rode uma vez:  /Users/mamute99/salvarchave"
  echo "Depois volte aqui e digite de novo:      /Users/mamute99/cobrar"
  echo "──────────────────────────────────────────────────────────"
  exit 1
fi

if [ "$1" = "sim" ]; then
  deno run --allow-env --allow-net --allow-read \
    --node-modules-dir=auto supabase/scripts/charge_unpaid_ride.ts "Jeff Reina" --confirm
else
  deno run --allow-env --allow-net --allow-read \
    --node-modules-dir=auto supabase/scripts/charge_unpaid_ride.ts "Jeff Reina"
fi
