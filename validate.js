// > The plan is to have the user setup only the bare minimum, and then have the server create the rest.
// > Once secrets, binaries and some basic configuration is set up, the first launch will put epochtal into
// > a fully usable state, having a first week and everything set up.
// - PancakeTAS

const fs = require('fs');

/**
 * Ensure a directory exists, creating it if it doesn't.
 * @param {string} dir The directory to ensure.
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir))
    fs.mkdirSync(dir);
}

/**
 * Ensure a file exists, creating it with the provided content if it doesn't.
 * @param {string} file The file to ensure.
 * @param {string} content The content to write to the file if it doesn't exist
 */
function ensureFile(file, content) {
  if (!fs.existsSync(file))
    Bun.write(file, content);
}

/**
 * Validate the global config and the basic directory structure.
 *
 * @returns {boolean} Whether the setup is valid or not.
 */
function validate() {
  // Validate the global config
  if (!gconfig.domain || !gconfig.secretsdir || !gconfig.datadir || !gconfig.bindir) {
    console.log("Global config is missing required fields: [domain, tls, secretsdir, datadir, bindir]");
    return false;
  }

  // Validate bindir
  if (!fs.existsSync(`${gconfig.bindir}/bspsrc`)) {
    console.log("BSPSource is not installed, epochtal will not function properly without it.");
    console.log("> https://github.com/ata4/bspsrc/releases");
    return false;
  }

  if (!fs.existsSync(`${gconfig.bindir}/mdp-json`)) {
    console.log("mdp-json is not installed, epochtal will not function properly without it.");
    console.log("> https://github.com/p2r3/mdp-json");
    return false;
  }

  if (!fs.existsSync(`${gconfig.bindir}/UntitledParser`)) {
    console.log("UntitledParser is not installed, epochtal will not function properly without it.");
    console.log("> https://github.com/UncraftedName/UntitledParser/releases");
    return false;
  }

  // Validate secretsdir
  if (gconfig.tls && (!fs.existsSync(`${gconfig.secretsdir}/fullchain.pem`) || !fs.existsSync(`${gconfig.secretsdir}/privkey.pem`))) {
    console.log("TLS is enabled, but fullchain.pem and privkey.pem are missing from secretsdir.");
    console.log("> Generate self-signed certificates or obtain them from a certificate authority.");
    return false;
  }

  if (!fs.existsSync(`${gconfig.secretsdir}/keys.js`)) {
    console.log("keys.js is missing from secretsdir. [discord, internal, jwt, steam, announcech, updatech, reportch]");
    return false;
  } else {
    const keys = require(`${gconfig.secretsdir}/keys.js`);
    if (!keys.discord || !keys.internal || !keys.jwt || !keys.steam || !keys.announcech || !keys.updatech || !keys.reportch) {
      console.log("keys.js is missing required fields: [discord, internal, jwt, steam, announcech, updatech, reportch]");
      return false;
    }
  }

  if (!fs.existsSync(`${gconfig.secretsdir}/weights.js`)) {
    console.log("weights.js is missing from secretsdir. Dumping default weights...");
    Bun.write(`${gconfig.secretsdir}/weights.js`, `module.exports = {
  v1: {
    PREVIEWS: 1,
    PREVIEWS_EXTRA: 1,
    PREVIEWS_VIDEO: 1,
    TAGS_COUNT: 1,
    TAGS_VISUALS: 1,
    HAMMER: 1,
    FILENAME: 1,
    DESC_NEWLINE: 1,
    DESC_FORMATTING: 1,
    REVISION: 1,
    TEXT_TURRETS: 1,
    TEXT_BEEMOD: 1,
    TEXT_RECREATION: 1,
    TITLE_LENGTH: 1,
    TITLE_CASE: 1,
    PLAYTIME_GAME: 1,
    PLAYTIME_EDITOR: 1,
    AUTHOR_WORKSHOP: 1
  },
  v2: {
    QUALITY_DEFAULT: 1,
    QUALITY_PUNISH: 1,
    SCORE_EXPONENT: 1,
    GROUPING_DEPTH: 1
  }
};`);
  }


  // Validate basic datadir structure

  ensureDir(`${__dirname}/.tmp`);
  ensureDir(`${gconfig.datadir}`);
  ensureDir(`${gconfig.datadir}/archives`);
  ensureDir(`${gconfig.datadir}/profiles`);
  ensureDir(`${gconfig.datadir}/spplice`);
  ensureDir(`${gconfig.datadir}/week`);
  ensureDir(`${gconfig.datadir}/week/proof`);


  ensureFile(`${gconfig.datadir}/users.json`, "{}"); // TODO: make first user admin
  ensureFile(`${gconfig.datadir}/entgraphs.json`, "{}");
  ensureFile(`${gconfig.datadir}/suggestions.json`, "[]");
  ensureFile(`${gconfig.datadir}/util.error`, "");
  ensureFile(`${gconfig.datadir}/util.print`, "");
  ensureFile(`${gconfig.datadir}/spplice/index.json`, `{"packages":[]}`);
  ensureFile(`${gconfig.datadir}/week/config.json`, `{"categories":[],"votingmaps":[{"id":"140534764"}],"votes":{},"number":0}`);
  ensureFile(`${gconfig.datadir}/week/leaderboard.json`, "{}");
  ensureFile(`${gconfig.datadir}/week/map.vmf.xz`, ""); // TODO: delete 0th archive/ensure it's not created
  ensureFile(`${gconfig.datadir}/week/week.log`, "");

  return true;
}

/**
 * Setup the epochtal server on first launch.
 */
async function setup() {

  const routines = require('./util/routine.js');

  // Get epochtal up and running
  await routines(["run", "epochtal", "concludeWeek"]);
  await routines(["run", "epochtal", "releaseMap"]);

  // Delete first archive
  fs.rmSync(`${gconfig.datadir}/archives/week0`, { recursive: true, force: true });

}

module.exports = {
  validate,
  setup
}