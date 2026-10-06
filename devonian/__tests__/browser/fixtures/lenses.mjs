import { customLens, fieldLens, recordLens, checkLensLaws } from 'devonian/lenses';

const lens = recordLens({
  name: fieldLens('title'),
  body: customLens({
    reads: ['body'], writes: ['body'],
    get: source => source.body ?? '',
    put: body => ({ set: { body } }),
  }),
});
const source = { title: 'Before', body: null, secret: 'keep' };
const desired = { name: 'After', body: '' };
const result = lens.put(desired, source);
globalThis.__result = {
  title: result.title,
  body: result.body,
  ...checkLensLaws(lens, source, desired),
};
