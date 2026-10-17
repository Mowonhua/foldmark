/** 二维码只携带所选地址，证书使用 Base64，避免十进制数组使码点过密；不改变原生连接协议。 */
import type { PairingOffer } from './contracts';
export function encodePairingOffer(offer: PairingOffer): string {
  return JSON.stringify({ version: offer.version, address: offer.address, certificate: btoa(String.fromCharCode(...offer.certificate)), token: offer.token, expires: offer.expires });
}
/** 兼容手动粘贴的原始数组格式；凭证有效期、协议及证书校验仍由原生连接端完成。 */
export function decodePairingOffer(text: string): PairingOffer {
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || typeof value.certificate !== 'string' && !Array.isArray(value.certificate)) throw new Error('配对信息无效');
  if (typeof value.certificate === 'string') {
    if (value.certificate.length > 12000) throw new Error('配对信息过长');
    value.certificate = Array.from(atob(value.certificate), character => character.charCodeAt(0));
  }
  return value as PairingOffer;
}
