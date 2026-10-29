import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * NENHUMA TELA PODE ANUNCIAR A VERSÃO COMO LITERAL.
 *
 * ── O QUE ESTE TESTE ESTÁ IMPEDINDO DE VOLTAR ──────────────────────────────
 *
 * `ProfileScreen.tsx` tinha `<Text>Go XL • v1.0.0</Text>` — um literal. Ele
 * dizia "v1.0.0" em toda build que já existiu, desde a primeira.
 *
 * Em 03/09/2026 isso custou um diagnóstico inteiro. Um Motorola em campo estava
 * sem mapa; a pergunta decisiva era "em que build este aparelho está"; o dono
 * leu "v1.0.0" nesta tela; e a conclusão — build anterior a 11/08, carregando a
 * chave do Google Maps que foi revogada quando as chaves foram separadas — foi
 * erguida sobre um número que nunca mudou. Ele desinstalou e reinstalou o app à
 * base dessa conclusão, sem efeito nenhum.
 *
 * Instrumento que mente é pior que instrumento ausente: sem ele a pergunta fica
 * aberta; com ele, a investigação segue com confiança na direção errada.
 *
 * A fonte da verdade é `versaoDoApp()` (src/lib/appVersion.ts), que lê
 * `Constants.expoConfig.version`.
 */

const RAIZ = join(__dirname, '..', '..');
/** `v1.2.3` ou `1.2.3` dentro de string/JSX — o formato de uma versão anunciada. */
const SUSPEITA = /\bv?\d+\.\d+\.\d+\b/;

function arquivosDeUI(dir: string, achados: string[] = []): string[] {
  for (const nome of readdirSync(dir)) {
    if (nome === '__tests__' || nome === 'node_modules') continue;
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) {
      arquivosDeUI(caminho, achados);
    } else if (/\.tsx$/.test(nome)) {
      achados.push(caminho);
    }
  }
  return achados;
}

/**
 * Só o que o usuário VÊ. Comentário citando uma versão é documentação legítima
 * — este arquivo mesmo cita várias — e barrar isso tornaria o teste um
 * estorvo que alguém desliga.
 */
function linhasVisiveis(conteudo: string): { n: number; texto: string }[] {
  const fora: { n: number; texto: string }[] = [];
  let emBloco = false;
  conteudo.split('\n').forEach((linha, i) => {
    const t = linha.trim();
    if (emBloco) {
      if (t.includes('*/')) emBloco = false;
      return;
    }
    if (t.startsWith('/*') || t.startsWith('{/*')) {
      if (!t.includes('*/')) emBloco = true;
      return;
    }
    if (t.startsWith('//') || t.startsWith('*')) return;
    fora.push({ n: i + 1, texto: linha });
  });
  return fora;
}

describe('nenhuma tela tem versão hardcoded', () => {
  const arquivos = arquivosDeUI(join(RAIZ, 'screens'))
    .concat(arquivosDeUI(join(RAIZ, 'components')));

  it('encontrou telas para inspecionar', () => {
    // Sem isto, um erro de caminho faria o teste passar vazio — e um teste que
    // não olha nada passa sempre.
    expect(arquivos.length).toBeGreaterThan(20);
  });

  it('não há literal de versão em código que renderiza', () => {
    const ofensas: string[] = [];
    for (const caminho of arquivos) {
      const conteudo = readFileSync(caminho, 'utf8');
      for (const { n, texto } of linhasVisiveis(conteudo)) {
        if (SUSPEITA.test(texto)) {
          ofensas.push(`${caminho.replace(RAIZ, 'src')}:${n} → ${texto.trim()}`);
        }
      }
    }
    expect(ofensas).toEqual([]);
  });
});
