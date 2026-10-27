import { describe, expect, it } from 'vitest';
import { describeTindakanOp, type TindakanOp } from './tindakanSync.js';

const op = (over: Partial<TindakanOp>): TindakanOp => ({ kind: 'updateTgl', endpointId: 'x', noTransaksi: '03-1', noRegistrasikunjungan: 'R', phase: 'p', reason: 'r', sequence: 0, ...over });

describe('describeTindakanOp', () => {
  it('states the charge, its value now and the value it will have', () => {
    expect(describeTindakanOp(op({ row: { nama_tindakan: 'JASA PELAYANAN' }, tglJam: '2026-06-13 08:00:00', targetDatetime: '2026-06-12 08:00:00' })))
      .toBe('JASA PELAYANAN: tanggal 2026-06-13 08:00 → 2026-06-12 08:00');
    expect(describeTindakanOp(op({ kind: 'tambah', namaTindakan: 'BIAYA RUANG', targetDatetime: '2026-06-12 00:00:00', harga: '150000' })))
      .toBe('BIAYA RUANG: ditambahkan tgl 2026-06-12 00:00 · Rp 150.000');
    expect(describeTindakanOp(op({ kind: 'setPelaksana', row: { nama_tindakan: 'JASA' }, pelaksana: 'PERAWAT A' }), 'PERAWAT B'))
      .toBe('JASA: pelaksana PERAWAT B → PERAWAT A');
    expect(describeTindakanOp(op({ kind: 'hapus', kdTindakan: 'T9', tglJam: '2026-06-14 09:00:00', row: { jumlah: '20000' } })))
      .toBe('tindakan T9 tgl 2026-06-14 09:00: dihapus (Rp 20.000)');
  });
});

describe('describeVisiteOp', () => {
  it('names the doctor change and the tariff fix', async () => {
    const { describeVisiteOp } = await import('./visiteSync.js');
    const base = { endpointId: 'x', noTransaksi: '03-1', noRegistrasikunjungan: 'R', reason: 'r', sequence: 1 };
    expect(describeVisiteOp({ ...base, kind: 'setPelaksana', row: { nama_tindakan: 'VISITE SPESIALIS' }, pelaksana: 'DR A' }, 'DR B')).toBe('VISITE SPESIALIS: dokter DR B → DR A');
    expect(describeVisiteOp({ ...base, kind: 'repairTarif', row: { nama_tindakan: 'VISITE X' }, correctedNamaTindakan: 'VISITE KLS 3', correctedHarga: 75000 })).toBe('VISITE X → VISITE KLS 3 · Rp 75.000');
  });
});
