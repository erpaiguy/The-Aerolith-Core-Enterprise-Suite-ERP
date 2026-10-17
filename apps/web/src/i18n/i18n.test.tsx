import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DICTIONARIES } from './dict';
import { LanguageProvider, useLanguage, useT, type Lang } from './i18n';

function Probe({ to }: { to?: Lang }) {
  const t = useT();
  const { setLang } = useLanguage();
  return (
    <>
      <p data-testid="save">{t('Save')}</p>
      <p data-testid="missing">{t('Only in English, {n} of them', { n: 3 })}</p>
      {to && <button onClick={() => setLang(to)}>switch</button>}
    </>
  );
}

describe('site screen languages (step 8g.5)', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('is English unless chosen, and fills placeholders', () => {
    render(
      <LanguageProvider>
        <Probe />
      </LanguageProvider>,
    );
    expect(screen.getByTestId('save').textContent).toBe('Save');
    expect(screen.getByTestId('missing').textContent).toBe('Only in English, 3 of them');
  });

  it('switches to Marathi, keeps the choice on the device, and falls back to English', () => {
    render(
      <LanguageProvider>
        <Probe to="mr" />
      </LanguageProvider>,
    );
    act(() => screen.getByText('switch').click());
    expect(screen.getByTestId('save').textContent).toBe('जतन करा');
    expect(screen.getByTestId('missing').textContent).toBe('Only in English, 3 of them');
    expect(localStorage.getItem('aerolith.lang')).toBe('mr');
    expect(document.documentElement.lang).toBe('mr');
  });

  it('keeps every placeholder of a string in its translations', () => {
    for (const lang of ['mr', 'hi'] as const)
      for (const [en, tr] of Object.entries(DICTIONARIES[lang])) {
        const want = (en.match(/\{\w+\}/g) ?? []).sort();
        expect([en, (tr.match(/\{\w+\}/g) ?? []).sort()]).toEqual([en, want]);
      }
  });
});
