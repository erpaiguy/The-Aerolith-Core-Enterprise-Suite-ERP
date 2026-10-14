// Amounts on printed documents always show the paise (₹4,720.00), as a bill or advice should; the screens may round.
const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const formatInr = (value: string | null | undefined): string =>
  value === null || value === undefined || value === '' ? '-' : INR.format(Number(value));
