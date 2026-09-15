import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  hasMetaProfileIdentityChange,
  instagramPictureKey,
  metaProfileIdentityChanged,
  metaProfileIdentityFromAccount,
  normalizeInstagramUsername,
} from './meta-profile-identity.ts';

const fotoA = 'https://scontent-iad3-2.cdninstagram.com/v/t51.82787-19/806299003_18056738672623054_352822839551525825_n.jpg?stp=dst-jpg_s206x206_tt6&_nc_ohc=cAkkIclpUQ0Q7kNvwFvsLP1&oh=00_AQJOzV0I&oe=6AAA8315';
const fotoAOutraAssinatura = 'https://scontent-gru2-2.cdninstagram.com/v/t51.82787-19/806299003_18056738672623054_352822839551525825_n.jpg?stp=dst-jpg_s206x206_tt6&_nc_ohc=ysB_A7QQAcAQ7kNvwGla8c5&oh=00_AQL5DiIA&oe=6AAF5895';
const fotoB = 'https://scontent-gru2-2.cdninstagram.com/v/t51.82787-19/999999999_1_1_n.jpg?oh=x&oe=y';

const gravado = { username: 'nonaornelas44036', display_name: 'nona ornelas', profile_picture_url: fotoA };

test('normalizeInstagramUsername ignora @, espaços e caixa', () => {
  assert.equal(normalizeInstagramUsername(' @NonaOrnelas44036 '), 'nonaornelas44036');
  assert.equal(normalizeInstagramUsername('@'), null);
  assert.equal(normalizeInstagramUsername(null), null);
});

test('instagramPictureKey extrai o arquivo e ignora host e assinatura', () => {
  assert.equal(instagramPictureKey(fotoA), '806299003_18056738672623054_352822839551525825_n.jpg');
  assert.equal(instagramPictureKey(fotoA), instagramPictureKey(fotoAOutraAssinatura));
  assert.notEqual(instagramPictureKey(fotoA), instagramPictureKey(fotoB));
  assert.equal(instagramPictureKey(null), null);
  assert.equal(instagramPictureKey('https://x/sem-extensao?oh=1'), null);
});

test('sem mudança real: mesmo username com @ e caixa, mesma foto com outra assinatura, nome nulo', () => {
  const diff = metaProfileIdentityChanged(gravado, {
    username: '@NonaOrnelas44036',
    displayName: null,
    profilePictureUrl: fotoAOutraAssinatura,
  });
  assert.deepEqual(diff, { username: false, displayName: false, picture: false });
  assert.equal(hasMetaProfileIdentityChange(diff), false);
});

test('renomeação de 15/09: username, nome e foto avaliados separadamente', () => {
  const diff = metaProfileIdentityChanged(gravado, {
    username: 'rochanatalia937',
    displayName: 'Natália da Rocha',
    profilePictureUrl: fotoAOutraAssinatura,
  });
  assert.deepEqual(diff, { username: true, displayName: true, picture: false });
  assert.equal(hasMetaProfileIdentityChange(diff), true);

  const soFoto = metaProfileIdentityChanged(gravado, { username: 'nonaornelas44036', displayName: 'nona ornelas', profilePictureUrl: fotoB });
  assert.deepEqual(soFoto, { username: false, displayName: false, picture: true });
});

test('perfil gravado sem nome ganha o nome da Meta; username vazio da Meta não conta', () => {
  const semNome = metaProfileIdentityChanged({ ...gravado, display_name: null }, { username: 'nonaornelas44036', displayName: 'nona ornelas', profilePictureUrl: null });
  assert.deepEqual(semNome, { username: false, displayName: true, picture: false });

  const semUsername = metaProfileIdentityChanged(gravado, { username: '', displayName: 'x', profilePictureUrl: null });
  assert.equal(semUsername.username, false);
});

test('metaProfileIdentityFromAccount só aceita resposta com username', () => {
  assert.equal(metaProfileIdentityFromAccount({ id: '1' }), null);
  assert.deepEqual(
    metaProfileIdentityFromAccount({ id: '1', username: 'a', name: 'A', profile_picture_url: fotoA, followers_count: 3 }),
    { username: 'a', displayName: 'A', profilePictureUrl: fotoA },
  );
  assert.deepEqual(metaProfileIdentityFromAccount({ username: 'a' }), { username: 'a', displayName: null, profilePictureUrl: null });
});
