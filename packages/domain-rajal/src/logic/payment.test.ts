import { describe, expect, it } from 'vitest';
import { tallyRajalBillLines } from './payment.js';

describe('tallyRajalBillLines', () => {
  it('sums the bill and the settled lines', () => {
    expect(tallyRajalBillLines([{ jumlah: '1000', flag: 'Belum' }, { jumlah: '500', flag: 'Sudah' }, { jumlah: 'x', flag: 'piutang' }])).toEqual({
      total: 1500,
      sudah: 500,
      sawFlag: true,
    });
  });

  it('reports an unread payment state when no line carries a flag', () => {
    expect(tallyRajalBillLines([{ jumlah: '1000' }])).toEqual({ total: 1000, sudah: 0, sawFlag: false });
    expect(tallyRajalBillLines([])).toEqual({ total: 0, sudah: 0, sawFlag: false });
  });
});
