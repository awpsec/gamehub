// Release-name → searchable title. The tricky cases are release-group names that
// double as real title words (ANOMALY/RUNE/CHRONOS…) — they must only strip as
// a scene TAG, never mid-title.
import test from 'node:test';
import assert from 'node:assert';
import { checker } from './_helpers.mjs';
import { cleanName } from '../src/namecleaner.js';

test('namecleaner: group/junk stripping keeps ambiguous title words', () => {
  const { check, done } = checker();
  const cases = [
    // ambiguous-group cases (group name doubles as a title word)
    ['RimWorld.Anomaly-SKIDROW', 'RimWorld Anomaly'],
    ['RimWorld.Anomaly.DLC-RUNE', 'RimWorld Anomaly'],
    ['RimWorld.Royalty.DLC-RUNE', 'RimWorld Royalty'],
    ['STALKER.Anomaly', 'STALKER Anomaly'],
    ['Game.Name.ANOMALY', 'Game Name'], // actual ANOMALY release (caps tag, no other group)
    ['Rune.2-CODEX', 'Rune 2'],
    // regressions from prior sessions — must all hold
    ['RimWorld.v1.5.4104-GOG', 'RimWorld'],
    ['Game.Name.CODEX', 'Game Name'],
    ['Elden.Ring.Shadow.of.the.Erdtree.v1.12-RUNE', 'Elden Ring Shadow of the Erdtree'],
    ['The.Witcher.3.Wild.Hunt.GOTY.MULTi14-ElAmigos', 'The Witcher 3 Wild Hunt GOTY'],
    ['pragmata.voices38', 'pragmata'],
    ['Black Myth-Wukong', 'Black Myth-Wukong'],
    ['Cities-Skylines', 'Cities-Skylines'],
    ['Cyberpunk 2077-CODEX', 'Cyberpunk 2077'],
    ['Hades.II.TENOKE', 'Hades II'],
    ['Workers.and.Resources.Soviet.Republic.v1.0.1.0.voices38', 'Workers and Resources Soviet Republic'],
    ['Total.War.SHOGUN.2-PLAZA', 'Total War SHOGUN 2'],
    ['Sons.of.the.Forest-RUNE', 'Sons of the Forest'],
    ['House.Flipper.2.Scooby.Doo.Pack-TENOKE', 'House Flipper 2 Scooby Doo Pack'],
    // distinctive groups strip in ANY case, even dotted mid-case forms
    ['RimWorld.FitGirl.Repack', 'RimWorld'],
    ['Game.Name.Dodi.Repack', 'Game Name'],
    ['RimWorld [FitGirl Repack]', 'RimWorld'],
    // Scene-style concatenation (no dots/spaces between title words) — general,
    // not RimWorld-specific. CamelCase + digit boundaries + hyphen splits.
    ['RimWorldRoyalty1-1-2647Win64.zip', 'RimWorld Royalty'],
    ['RimWorldPrototypePack.zip', 'RimWorld Prototype Pack'],
    ['RedDeadRedemption2-CODEX', 'Red Dead Redemption 2'],
    ['GrandTheftAutoV.Legacy-FITGIRL', 'Grand Theft Auto V Legacy'],
    ['TheWitcher3WildHuntGOTY', 'The Witcher 3 Wild Hunt GOTY'],
    ['AgeOfMythologyRetold-RUNE', 'Age Of Mythology Retold'],
    ['HouseFlipper2ScoobyDooPack-TENOKE', 'House Flipper 2 Scooby Doo Pack'],
  ];
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  for (const [input, want] of cases) {
    const got = cleanName(input).clean;
    check(`${input} -> ${want}`, norm(got) === norm(want), `got "${got}"`);
  }
  done(assert);
});

test('namecleaner: update classification (position + adjacency)', () => {
  const { check, done } = checker();
  check('Update.vN is an update', cleanName('Age.of.Mythology.Retold.Update.v17.22308-TENOKE').isUpdate === true);
  check('named update is an update', cleanName('Age.of.Mythology.Retold.Obsidian.Mirror.Update.v100.19.15437-RUNE').isUpdate === true);
  check('bare-number update form', cleanName('Anno.2205.Update.4-CODEX').isUpdate === true);
  check('build-form update', cleanName('Satisfactory.Update.Build.365306-CODEX').isUpdate === true);
  check('plain game is not an update', cleanName('RimWorld.v1.5.4104-GOG').isUpdate === false);
  check('DLC pack is not an update', cleanName('RimWorld.Royalty.DLC-RUNE').isUpdate === false);
  check('game TITLED "Patch …" is not an update', cleanName('Patch.Quest.v1.2-TENOKE').isUpdate === false);
  check('update word with no following version is a title', cleanName('Big.Update.Adventures.Remastered').isUpdate === false);
  check('versionless "update" word is not an update', cleanName('The.Big.Update.Game').isUpdate === false);
  done(assert);
});
