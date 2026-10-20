// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RECIPE } from '../shot/recipeForm';
import { DRAFT_KEY, memoryStorage, type KeyValueStore } from '../shot/storage';
import {
  createSetupStorage,
  MAX_SETUP_BYTES,
  SETUP_COOKIE_NAME,
  SETUP_MAX_AGE_SECONDS,
  SETUP_RECORD_KEY,
  SETUP_SCHEMA,
  setupCookiePath,
  type CookieJar,
  type EquipmentSetupRecord,
} from './setupStorage';

const NOW = Date.parse('2026-10-20T04:00:00.000Z');
const record = (): EquipmentSetupRecord => ({
  schema: SETUP_SCHEMA,
  recipe: structuredClone(DEFAULT_RECIPE),
  completedAt: new Date(NOW).toISOString(),
});

function cookieJar(initial = '') {
  let value = initial;
  const writes: string[] = [];
  const jar: CookieJar = {
    read: () => value,
    write: (text) => {
      writes.push(text);
      value = text.includes('Max-Age=0;') ? '' : text.split(';')[0];
    },
  };
  return { jar, writes, value: () => value };
}

function environment(storage = memoryStorage(), cookies = cookieJar()) {
  return {
    storage,
    cookies,
    options: {
      storage,
      cookies: cookies.jar,
      baseUrl: './',
      pageUrl: 'https://example.com/puckworks/index.html?mode=lab#main',
      baseURI: 'https://example.com/puckworks/index.html?mode=lab#main',
      now: () => NOW,
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('first-party equipment completion storage', () => {
  it.each([
    ['./', 'https://example.com/', '/'],
    ['./', 'https://example.com/index.html?q=1#lab', '/'],
    ['./', 'https://example.com/puckworks/', '/puckworks/'],
    ['./', 'https://example.com/puckworks/index.html?q=1#lab', '/puckworks/'],
    ['/other-app/', 'https://example.com/puckworks/index.html', '/other-app/'],
  ])('scopes %s against the document address %s', (base, page, path) => {
    expect(setupCookiePath(base, page)).toBe(path);
  });

  it('resolves the production relative base against document.baseURI rather than a fixed root', () => {
    const storage = memoryStorage();
    const cookies = cookieJar();
    vi.stubEnv('BASE_URL', './');
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('location', { href: 'https://example.com/puckworks-e2e/index.html#first' });
    vi.stubGlobal('document', {
      baseURI: 'https://example.com/puckworks-e2e/index.html',
      get cookie() {
        return cookies.jar.read();
      },
      set cookie(value: string) {
        cookies.jar.write(value);
      },
    });
    const setup = createSetupStorage({ now: () => NOW });
    expect(setup.cookiePath).toBe('/puckworks-e2e/');
    expect(setup.complete(record()).persisted).toBe(true);
    expect(cookies.writes[0]).toContain('Path=/puckworks-e2e/;');
  });

  it('stores only a nonunique marker in a same-site secure cookie and recovers the full local recipe', () => {
    const f = environment();
    const setup = createSetupStorage(f.options);
    const original = record();
    expect(setup.load()).toBeNull();
    expect(setup.complete(original)).toEqual({ persisted: true, notice: null });
    expect(f.cookies.writes).toEqual([
      `${SETUP_COOKIE_NAME}=done; Path=/puckworks/; Max-Age=${SETUP_MAX_AGE_SECONDS}; SameSite=Strict; Secure`,
    ]);
    expect(f.cookies.writes[0]).not.toContain('Domain=');
    expect(f.cookies.writes[0]).not.toContain(original.recipe.grinder.preset);
    expect(setup.recordKey).toBe(`${SETUP_RECORD_KEY}:/puckworks/`);
    const saved = JSON.parse(f.storage.getItem(setup.recordKey!)!) as EquipmentSetupRecord;
    expect(saved.recipe).toEqual(original.recipe);
    expect(saved.expiresAt).toBe(new Date(NOW + SETUP_MAX_AGE_SECONDS * 1000).toISOString());
    expect(JSON.parse(f.storage.getItem(DRAFT_KEY)!)).toEqual(original.recipe);
    const returning = createSetupStorage(f.options);
    expect(returning.load()).toEqual(saved);
    original.recipe.prep.dose_g = 21;
    expect(setup.load()?.recipe.prep.dose_g).toBe(18);
    const restored = setup.load()!;
    restored.recipe.prep.dose_g = 22;
    expect(setup.load()?.recipe.prep.dose_g).toBe(18);
  });

  it('does not add Secure on local HTTP, and isolates setup records by app subpath', () => {
    const f = environment();
    const first = createSetupStorage({
      ...f.options,
      pageUrl: 'http://localhost:5173/app/',
      baseURI: 'http://localhost:5173/app/',
    });
    expect(first.complete(record()).persisted).toBe(true);
    expect(f.cookies.writes[0]).not.toContain('Secure');
    const second = createSetupStorage({
      ...f.options,
      pageUrl: 'http://localhost:5173/other/',
      baseURI: 'http://localhost:5173/other/',
    });
    expect(second.recordKey).not.toBe(first.recordKey);
    expect(second.load()).toBeNull();
  });

  it('prefers a valid current Lab draft and preserves its advanced fields', () => {
    const f = environment();
    createSetupStorage(f.options).complete(record());
    const updated = {
      ...DEFAULT_RECIPE,
      prep: { ...DEFAULT_RECIPE.prep, dose_g: 19.5, paper_bottom: true },
      water: { ph: 6.5 },
      chemistry: { aroma_age_s: 90 },
      overrides: { 'extraction.max_yield': 0.3 },
    };
    f.storage.setItem(DRAFT_KEY, JSON.stringify(updated));
    expect(createSetupStorage(f.options).load()?.recipe).toEqual(updated);
  });

  it('recovers damaged recipe data only when valid expiry metadata and a valid draft still exist', () => {
    const f = environment();
    const setup = createSetupStorage(f.options);
    setup.complete(record());
    const saved = JSON.parse(f.storage.getItem(setup.recordKey!)!) as EquipmentSetupRecord;
    Object.assign(saved, { recipe: { broken: true } });
    delete saved.completedAt;
    f.storage.setItem(setup.recordKey!, JSON.stringify(saved));
    expect(createSetupStorage(f.options).load()).toEqual({ ...saved, recipe: DEFAULT_RECIPE });
    f.storage.removeItem(setup.recordKey!);
    expect(createSetupStorage(f.options).load()).toBeNull();
  });

  it.each([
    '',
    `${SETUP_COOKIE_NAME}=other`,
    `prefix_${SETUP_COOKIE_NAME}=done`,
    `${SETUP_COOKIE_NAME}=done=extra`,
    `${SETUP_COOKIE_NAME}=done; ${SETUP_COOKIE_NAME}=done`,
  ])(
    'can restore valid local setup despite an absent, malformed or ambiguous marker %s',
    (cookie) => {
      const f = environment();
      createSetupStorage(f.options).complete(record());
      expect(
        createSetupStorage({ ...f.options, cookies: cookieJar(cookie).jar }).load()?.recipe,
      ).toEqual(DEFAULT_RECIPE);
    },
  );

  it('enforces record expiry even when the browser retains the cookie past its lifetime', () => {
    const f = environment();
    const setup = createSetupStorage(f.options);
    setup.complete(record());
    const afterYear = { ...f.options, now: () => NOW + SETUP_MAX_AGE_SECONDS * 1000 };
    expect(createSetupStorage(afterYear).load()).toBeNull();
    expect(f.cookies.value()).toBe(`${SETUP_COOKIE_NAME}=done`);
    const saved = JSON.parse(f.storage.getItem(setup.recordKey!)!) as EquipmentSetupRecord;
    delete saved.expiresAt;
    f.storage.setItem(setup.recordKey!, JSON.stringify(saved));
    expect(createSetupStorage(f.options).load()).toBeNull();
  });

  it('never treats a cookie alone, or a cookie plus a draft without expiry metadata, as completion', () => {
    const f = environment(memoryStorage(), cookieJar(`${SETUP_COOKIE_NAME}=done`));
    expect(createSetupStorage(f.options).load()).toBeNull();
    f.storage.setItem(DRAFT_KEY, JSON.stringify(DEFAULT_RECIPE));
    expect(createSetupStorage(f.options).load()).toBeNull();
  });

  it('retains fully specified custom equipment rather than reducing it to preset fields', () => {
    const f = environment();
    const value = record();
    value.recipe.grinder = {
      psd: { diameter_um: [50, 300], volume_fraction: [0.3, 0.7], method: 'image' },
    };
    value.recipe.basket = {
      custom: {
        profile_mm: [
          [0, 58],
          [20, 60],
        ],
        perforated_diameter_mm: 50,
        open_area_fraction: 0.03,
      },
    };
    value.recipe.machine = {
      preset: 'flat-9-bar',
      profile: [
        { control: 'flow', target: 4, until_time_s: 5 },
        { control: 'pressure', target: 9 },
      ],
      pump: { type: 'vibratory', free_flow_ml_s: 7, stall_pressure_bar: 15, opv_bar: 9 },
      headspace_ml: 4,
    };
    expect(createSetupStorage(f.options).complete(value).persisted).toBe(true);
    expect(createSetupStorage(f.options).load()?.recipe).toEqual(value.recipe);
  });

  it.each(['unknown_custom_field', 'invalid_profile', 'invalid_psd', 'huge_psd'])(
    'refuses stale or malformed native custom fields on return: %s',
    (kind) => {
      const f = environment();
      const setup = createSetupStorage(f.options);
      setup.complete(record());
      const saved = JSON.parse(f.storage.getItem(setup.recordKey!)!) as EquipmentSetupRecord;
      if (kind === 'unknown_custom_field') {
        saved.recipe.basket = {
          custom: {
            profile_mm: [
              [0, 58],
              [20, 60],
            ],
            perforated_diameter_mm: 50,
            obsolete_native_field: 1,
          },
        } as unknown as typeof saved.recipe.basket;
      } else if (kind === 'invalid_profile') {
        saved.recipe.machine.profile = [
          { control: 'flow', target: 4 },
          { control: 'pressure', target: 9 },
        ];
      } else {
        const count = kind === 'huge_psd' ? 2001 : 2;
        saved.recipe.grinder.psd = {
          diameter_um:
            kind === 'huge_psd' ? Array.from({ length: count }, (_, i) => i + 1) : [200, 100],
          volume_fraction: Array.from({ length: count }, () => 1 / count),
        };
      }
      f.storage.setItem(setup.recordKey!, JSON.stringify(saved));
      f.storage.removeItem(DRAFT_KEY);
      expect(createSetupStorage(f.options).load()).toBeNull();
    },
  );

  it.each([
    (saved: EquipmentSetupRecord) => ({ ...saved, schema: 'other' }),
    (saved: EquipmentSetupRecord) => ({ ...saved, expiresAt: '2027-02-30T00:00:00.000Z' }),
    (saved: EquipmentSetupRecord) => ({ ...saved, expiresAt: '2099-01-01T00:00:00.000Z' }),
    (saved: EquipmentSetupRecord) => ({ ...saved, completedAt: 'not a date' }),
    (saved: EquipmentSetupRecord) => ({ ...saved, extra: true }),
  ])('ignores corrupt or unsupported saved metadata', (change) => {
    const f = environment();
    const setup = createSetupStorage(f.options);
    setup.complete(record());
    const saved = JSON.parse(f.storage.getItem(setup.recordKey!)!) as EquipmentSetupRecord;
    f.storage.setItem(setup.recordKey!, JSON.stringify(change(saved)));
    expect(createSetupStorage(f.options).load()).toBeNull();
  });

  it('ignores malformed and oversized local data without deleting any saved draft', () => {
    const f = environment();
    const setup = createSetupStorage(f.options);
    setup.complete(record());
    const draft = f.storage.getItem(DRAFT_KEY);
    for (const text of ['null', '{broken', 'x'.repeat(MAX_SETUP_BYTES + 1)]) {
      f.storage.setItem(setup.recordKey!, text);
      expect(createSetupStorage(f.options).load()).toBeNull();
      expect(f.storage.getItem(DRAFT_KEY)).toBe(draft);
    }
  });

  it('falls back from an invalid draft to the validated saved setup recipe', () => {
    const f = environment();
    createSetupStorage(f.options).complete(record());
    f.storage.setItem(DRAFT_KEY, JSON.stringify({ ...DEFAULT_RECIPE, prep: { dose_g: 999 } }));
    expect(createSetupStorage(f.options).load()?.recipe).toEqual(DEFAULT_RECIPE);
  });

  it.each([
    (r: EquipmentSetupRecord) => {
      r.recipe.prep.dose_g = Number.NaN;
    },
    (r: EquipmentSetupRecord) => {
      r.recipe.prep.dose_g = 999;
    },
    (r: EquipmentSetupRecord) => {
      r.completedAt = '2026-02-30T04:00:00.000Z';
    },
    (r: EquipmentSetupRecord) => {
      r.completedAt = '2020-01-01T00:00:00.000Z';
    },
    (r: EquipmentSetupRecord) => {
      (r.recipe as unknown as Record<string, unknown>).unknown = 1;
    },
    (r: EquipmentSetupRecord) => {
      r.recipe.grinder.psd = { diameter_um: [200, 100], volume_fraction: [0.5, 0.5] };
    },
  ])('refuses invalid equipment before marking or saving completion', (mutate) => {
    const f = environment();
    const setup = createSetupStorage(f.options);
    const value = record();
    mutate(value);
    expect(() => setup.complete(value)).toThrow();
    expect(f.cookies.writes).toEqual([]);
    expect(f.storage.getItem(DRAFT_KEY)).toBeNull();
    expect(setup.load()).toBeNull();
  });

  it('keeps the current session usable when local storage throws or silently rejects writes', () => {
    const f = environment();
    const denied: KeyValueStore = {
      getItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
      removeItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
    };
    for (const storage of [null, denied, { ...memoryStorage(), setItem: () => {} }]) {
      const setup = createSetupStorage({ ...f.options, storage });
      const result = setup.complete(record());
      expect(result.persisted).toBe(false);
      expect(result.notice).toMatch(/ready for this session/);
      expect(setup.load()?.recipe).toEqual(DEFAULT_RECIPE);
      expect(createSetupStorage({ ...f.options, storage }).load()).toBeNull();
    }
    expect(f.cookies.writes).toEqual([]);
  });

  it.each(['throw', 'ignore'])(
    'does not publish completion over an older draft when the draft write is rejected: %s',
    (failure) => {
      const f = environment();
      f.storage.setItem(DRAFT_KEY, JSON.stringify(DEFAULT_RECIPE));
      const writes: string[] = [];
      const storage: KeyValueStore = {
        ...f.storage,
        setItem: (key, value) => {
          writes.push(key);
          if (key === DRAFT_KEY) {
            if (failure === 'throw') throw new DOMException('full', 'QuotaExceededError');
            return;
          }
          f.storage.setItem(key, value);
        },
      };
      const setup = createSetupStorage({ ...f.options, storage });
      const updated = record();
      updated.recipe.prep.dose_g = 19;
      const result = setup.complete(updated);
      expect(result.persisted).toBe(false);
      expect(result.notice).toContain('could not be saved completely');
      expect(writes).toEqual([DRAFT_KEY]);
      expect(f.storage.getItem(setup.recordKey!)).toBeNull();
      expect(JSON.parse(f.storage.getItem(DRAFT_KEY)!)).toEqual(DEFAULT_RECIPE);
      expect(setup.load()?.recipe).toEqual(updated.recipe);
      expect(createSetupStorage(f.options).load()).toBeNull();
      expect(f.cookies.writes).toEqual([]);
    },
  );

  it('preserves an earlier completion and expiry when saving a replacement draft fails', () => {
    const f = environment();
    const prior = createSetupStorage(f.options);
    prior.complete(record());
    const previous = f.storage.getItem(prior.recordKey!);
    f.cookies.writes.length = 0;
    const setup = createSetupStorage({
      ...f.options,
      storage: {
        ...f.storage,
        setItem: (key, value) => {
          if (key === DRAFT_KEY) throw new DOMException('full', 'QuotaExceededError');
          f.storage.setItem(key, value);
        },
      },
      now: () => NOW + 60_000,
    });
    const updated = record();
    updated.recipe.prep.dose_g = 19;
    updated.completedAt = new Date(NOW + 60_000).toISOString();
    expect(setup.complete(updated).persisted).toBe(false);
    expect(f.storage.getItem(prior.recordKey!)).toBe(previous);
    expect(createSetupStorage(f.options).load()?.recipe).toEqual(DEFAULT_RECIPE);
    expect(setup.load()?.recipe).toEqual(updated.recipe);
    expect(f.cookies.writes).toEqual([]);
  });

  it.each([false, true])(
    'keeps the updated draft without publishing completion when its record write fails (prior completion %s)',
    (hasPrior) => {
      const f = environment();
      const prior = createSetupStorage(f.options);
      if (hasPrior) prior.complete(record());
      const previous = f.storage.getItem(prior.recordKey!);
      f.cookies.writes.length = 0;
      const writes: string[] = [];
      const storage: KeyValueStore = {
        ...f.storage,
        setItem: (key, value) => {
          writes.push(key);
          if (key === prior.recordKey) throw new DOMException('full', 'QuotaExceededError');
          f.storage.setItem(key, value);
        },
      };
      const updated = record();
      updated.recipe.prep.dose_g = 19;
      const setup = createSetupStorage({ ...f.options, storage });
      expect(setup.complete(updated).persisted).toBe(false);
      expect(writes).toEqual([DRAFT_KEY, prior.recordKey]);
      expect(f.storage.getItem(prior.recordKey!)).toBe(previous);
      expect(JSON.parse(f.storage.getItem(DRAFT_KEY)!)).toEqual(updated.recipe);
      // An existing unexpired completion still permits normal draft updates.
      // Without one, the recoverable draft only prefills required setup.
      expect(createSetupStorage(f.options).load()?.recipe ?? null).toEqual(
        hasPrior ? updated.recipe : null,
      );
      expect(f.cookies.writes).toEqual([]);
    },
  );

  it('detects throwing or silently blocked cookies independently from local storage', () => {
    const f = environment();
    for (const cookies of [
      null,
      { read: () => '', write: () => {} },
      {
        read: () => {
          throw new DOMException('cookies blocked', 'SecurityError');
        },
        write: () => {
          throw new DOMException('cookies blocked', 'SecurityError');
        },
      },
    ]) {
      const setup = createSetupStorage({ ...f.options, cookies });
      const result = setup.complete(record());
      expect(result.persisted).toBe(true);
      expect(result.notice).toMatch(/setup cookie is unavailable/);
      expect(setup.load()?.recipe).toEqual(DEFAULT_RECIPE);
      expect(createSetupStorage({ ...f.options, cookies }).load()?.recipe).toEqual(DEFAULT_RECIPE);
    }
  });

  it('clears the matching path marker and setup record, preserving Lab and journal data', () => {
    const f = environment();
    const setup = createSetupStorage(f.options);
    setup.complete(record());
    f.storage.setItem('journal-sentinel', 'preserve');
    const draft = f.storage.getItem(DRAFT_KEY);
    expect(setup.clear()).toEqual({ cleared: true, notice: null });
    expect(f.cookies.writes.at(-1)).toBe(
      `${SETUP_COOKIE_NAME}=; Path=/puckworks/; Max-Age=0; SameSite=Strict; Secure`,
    );
    expect(setup.load()).toBeNull();
    expect(createSetupStorage(f.options).load()).toBeNull();
    expect(f.storage.getItem(DRAFT_KEY)).toBe(draft);
    expect(f.storage.getItem('journal-sentinel')).toBe('preserve');
  });

  it('retains an explicit session reset even if browser data cannot be cleared', () => {
    const f = environment();
    const setup = createSetupStorage(f.options);
    setup.complete(record());
    const blocked = createSetupStorage({
      ...f.options,
      storage: {
        ...f.storage,
        removeItem: () => {
          throw new Error('blocked');
        },
      },
      cookies: {
        read: () => f.cookies.jar.read(),
        write: () => {
          throw new Error('blocked');
        },
      },
    });
    expect(blocked.load()).not.toBeNull();
    expect(blocked.clear().cleared).toBe(false);
    expect(blocked.load()).toBeNull();
  });

  it('rejects foreign or delimiter-bearing app paths while still allowing a session setup', () => {
    expect(() => setupCookiePath('https://other.example/app/', 'https://example.com/')).toThrow();
    expect(() => setupCookiePath('/app; Domain=other/', 'https://example.com/')).toThrow();
    const f = environment();
    const setup = createSetupStorage({ ...f.options, baseUrl: 'https://other.example/' });
    expect(setup.complete(record()).persisted).toBe(false);
    expect(setup.load()?.recipe).toEqual(DEFAULT_RECIPE);
    expect(f.cookies.writes).toEqual([]);
  });
});
