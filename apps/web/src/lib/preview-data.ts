export const ACCOUNT_ID = 'bn:spot:testnet:acct_72c4••••81d9';
export const PLAN_ID = 'plan_01J7QX9X4JYH3ZW2D51PP08ZB8';
export const PLAN_DIGEST =
  'sha256:9f3124cb7888ef1510db67bd97bd3f0be71433537ad4cffda29d6ef40af6fbc1';

export const CAPITAL = [
  {
    asset: 'USDT',
    account: '18,450.00000000',
    available: '12,750.00000000',
    reserved: '4,500.00000000',
    house: '1,200.00000000',
    quarantined: '0.00000000',
    status: 'RECONCILED',
  },
  {
    asset: 'BTC',
    account: '0.38450000',
    available: '0.27000000',
    reserved: '0.06450000',
    house: '0.05000000',
    quarantined: '0.00000000',
    status: 'RECONCILED',
  },
  {
    asset: 'BNB',
    account: '0.02133719',
    available: '0.00000000',
    reserved: '0.00000000',
    house: '0.01890000',
    quarantined: '0.00243719',
    status: 'DRIFT QUARANTINE',
  },
] as const;

export const INTENTS = [
  {
    strategy: 'Reserve ladder',
    id: 'strategy_alpha_3b8a4d90c7742af1',
    target: '0.32000000',
    owned: '0.21000000',
    committed: '0.06450000',
    delta: '+0.04550000',
    limit: '≤ 67,240.10 USDT/BTC',
    revision: 'r18',
    state: 'ELIGIBLE',
  },
  {
    strategy: 'Volatility sleeve',
    id: 'strategy_beta_800e91a2ef019d72',
    target: '0.13500000',
    owned: '0.06000000',
    committed: '0.00000000',
    delta: '+0.07500000',
    limit: '≤ 67,110.00 USDT/BTC',
    revision: 'r07',
    state: 'ELIGIBLE',
  },
  {
    strategy: 'Protective unwind',
    id: 'strategy_gamma_c11d209ea14c320f',
    target: '0.02000000',
    owned: '0.05000000',
    committed: '0.00000000',
    delta: '−0.03000000',
    limit: '≥ 66,980.00 USDT/BTC',
    revision: 'r03',
    state: 'CONFLICT',
  },
] as const;

export function isCanonicalDecimal(value: string): boolean {
  return /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value.replaceAll(',', ''));
}

export function previewMode(environment: Record<string, string | undefined>): boolean {
  return environment['CAPITALDESK_UI_PREVIEW'] === 'true';
}
