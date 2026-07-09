-- Item 4 — impedir cadastro DUPLICADO do mesmo veículo pelo mesmo motorista.
--
-- Modelo do app: um motorista tem UM veículo, editado no lugar (update por id).
-- O único vetor de duplicidade é uma corrida de estado obsoleto (o hook acha que
-- não há veículo e faz INSERT quando já existe uma linha), gerando duas linhas
-- para o mesmo motorista. Isso quebra o carregamento (maybeSingle vê 2 linhas).
--
-- Duas camadas de defesa:
--   1) o hook useVehicle agora reconsulta o veículo do motorista antes de decidir
--      entre INSERT e UPDATE (fecha a corrida no cliente);
--   2) este índice único é a GARANTIA no banco: o mesmo motorista não grava a
--      MESMA placa duas vezes — mesmo que um caminho de código com bug tente.
--
-- Normalização: o app grava a placa já com trim()+UPPER, mas o índice usa a
-- MESMA expressão para ser robusto a qualquer outro caminho de escrita.

-- (a) Colapsa duplicatas exatas pré-existentes (mesmo motorista + mesma placa),
--     mantendo a linha mais recente. São o MESMO carro recadastrado — nenhum
--     histórico único se perde. Necessário para o índice único poder ser criado.
delete from public.vehicles v
using (
  select
    id,
    row_number() over (
      partition by driver_id, upper(trim(plate))
      order by created_at desc, id desc
    ) as rn
  from public.vehicles
) d
where v.id = d.id
  and d.rn > 1;

-- (b) Índice único por (motorista, placa normalizada).
create unique index if not exists vehicles_driver_plate_unique
  on public.vehicles (driver_id, upper(trim(plate)));
