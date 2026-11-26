/**
 * Chave pública das versões do Playzin (ed25519). O console só instala um pacote cuja assinatura
 * confere com esta chave: mesmo que alguém mexa no servidor ou na rede, um pacote que não foi
 * assinado com a chave privada (guardada fora do projeto, e no GitHub como o segredo
 * PLAYZIN_RELEASE_KEY) é recusado.
 *
 * Trocar a chave: gere um par novo (node scripts/release/keygen.mjs), troque esta e o segredo.
 * Consoles com a chave antiga só aceitam a nova depois de uma versão assinada com a antiga que
 * já traga a chave nova.
 */
export const RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAoU8uxA4sA05ExCAGDlqeqAIjCwucDZpY1QV3ItHxRkw=
-----END PUBLIC KEY-----
`;

/** O que a assinatura cobre: a versão e a impressão digital (sha256) do pacote. */
export function signedMessage(version: string, sha256: string): string {
  return `playzin-release:${version}:${sha256}`;
}
