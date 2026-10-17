import { expect, it } from 'vitest';
import { encodePairingOffer, decodePairingOffer } from './pairing-code';
import type { PairingOffer } from './contracts';
it('二维码压缩证书并保留全部字节，旧手动格式仍能读取', () => {
  const offer: PairingOffer = { version: 1, address: '192.168.1.2:1234', addresses: ['192.168.1.2:1234', '172.16.0.1:1234'], certificate: Array.from({ length: 400 }, (_, i) => i % 256), token: 'f'.repeat(64), expires: 9999999999 };
  expect(decodePairingOffer(encodePairingOffer(offer))).toEqual({ ...offer, addresses: undefined });
  expect(encodePairingOffer(offer).length).toBeLessThan(JSON.stringify(offer).length * .6);
  expect(decodePairingOffer(JSON.stringify(offer))).toEqual(offer);
  expect(() => decodePairingOffer('{}')).toThrow('配对信息无效');
});
