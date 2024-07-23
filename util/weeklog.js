const UtilError = require("./error.js");

const { appendFileSync } = require("node:fs");
const categories = require("./categories.js");
const config = require("./config.js");
const archive = require("./archive.js");
const users = require("./users.js");

/**
 * Parses a weeklog buffer into an array of objects
 *
 * @param {Array} buffer Buffer containing weeklog data
 * @param {string[]} categoryList  List of categories
 * @returns Array of objects representing weeklog entries
 */
function parseLog (buffer, categoryList) {

  const log = [];

  for (let i = 0; i < buffer.length / 17; i ++) {

    // each entry is 17 bytes long
    const curr = i * 17;
    const entry = {};

    // 8 bytes - steamid
    let steamid = 0n;
    for (let j = 0; j < 8; j ++) {
      steamid += BigInt(buffer[curr + j]) * BigInt(Math.pow(256, 7 - j));
    }
    entry.steamid = steamid.toString();

    // 1 byte - category index
    entry.category = categoryList[buffer[curr + 8]];

    // 4 bytes - run time in ticks
    entry.time = 0;
    for (let j = 0; j < 4; j ++) {
      entry.time += buffer[curr + 9 + j] * Math.pow(256, 3 - j);
    }

    // 1 byte - portal count
    entry.portals = buffer[curr + 13];

    // 3 bytes - seconds since start of the week
    entry.timestamp = 0;
    for (let j = 0; j < 3; j ++) {
      entry.timestamp += buffer[curr + 14 + j] * Math.pow(256, 2 - j);
    }

    // this pattern marks the removal of an entry
    if (entry.time === 0 && entry.portals === 0) {

      for (let j = log.length - 1; j >= 0; j --) {
        // look for the last run by the same user in the same category and remove it
        if (log[j].steamid === entry.steamid && log[j].category === entry.category) {
          log.splice(j, 1);
          break;
        }
      }

    } else {

      log.push(entry);

    }

  }

  return log;

}

/**
 * Encodes a weeklog entry object into a buffer
 *
 * @param {object} entry Weeklog entry object
 * @param {string[]} categoryList List of categories
 * @returns {Uint8Array} buffer containing the encoded entry
 */
function encodeLogEntry (entry, categoryList) {

  const buffer = new Uint8Array(17);

  // 8 bytes - steamid
  const steamid = BigInt(entry.steamid);
  for (let i = 0; i < 8; i ++) {
    buffer[i] = Number(steamid % (256n ** BigInt(8 - i)) / (256n ** BigInt(7 - i)));
  }

  // 1 byte - category index
  buffer[8] = categoryList.indexOf(entry.category);

  // 4 bytes - run time in ticks
  for (let i = 0; i < 4; i ++) {
    buffer[9 + i] = entry.time % (256 ** (4 - i)) / (256 ** (3 - i));
  }

  // 1 byte - portal count
  buffer[13] = entry.portals;

  // 3 bytes - seconds since start of the week
  for (let i = 0; i < 3; i ++) {
    buffer[14 + i] = entry.timestamp % (256 ** (3 - i)) / (256 ** (2 - i));
  }

  return buffer;

}

/**
 * Handles the `weeklog` utility call. This utility is used to manage the weeklog.
 *
 * The following subcommands are available:
 * - `read`: Read the weeklog file
 * - `remove`: Remove an entry from the weeklog
 * - `add`: Add an entry to the weeklog
 * - `reconstruct`: Reconstruct the weeklog into a leaderboard format
 *
 * @param {string[]} args The arguments for the call
 * @param {unknown} context The context on which to execute the call (defaults to epochtal)
 * @returns {object|string} The output of the call
 */
module.exports = async function (args, context = epochtal) {

  const [command] = args;

  // Grab weeklog file path
  const filePath = context.file.log;
  const file = Bun.file(filePath);

  switch (command) {

    case "read": {

      // Get categories and parse the weeklog
      const categoryList = await categories(["list"], context);
      const buffer = new Uint8Array(await file.arrayBuffer());

      return parseLog(buffer, categoryList);

    }

    case "remove": {

      // Ensure timestamp is provided
      const timestamp = args[1];
      if (timestamp === undefined) throw new UtilError("ERR_ARGS", args, context);

      const buffer = new Uint8Array(await file.arrayBuffer());

      // Search for the entry with the provided timestamp
      let found = null;
      for (let i = 0; i < buffer.length; i += 17) {

        // Get timestamp of current entry
        let curr = 0;
        for (let j = 0; j < 3; j ++) {
          curr += buffer[i + 14 + j] * Math.pow(256, 3 - j);
        }

        if (curr === timestamp) {
          found = i;
          break;
        }

      }

      // Ensure entry was found
      if (found === null) throw new UtilError("ERR_TIMESTAMP", args, context);

      // Remove entry from buffer
      for (let i = found + 17; i < buffer.length; i ++) {
        buffer[i - 17] = buffer[i];
      }

      // Write buffer back to file
      await Bun.write(file, buffer.slice(0, -17));

      return "SUCCESS";

    }

    case "add": {

      const [steamid, category, time, portals, timestamp] = args.slice(1);
      const entry = {steamid, category, time, portals, timestamp};

      // Grab current timestamp if not provided
      if (!entry.timestamp) {
        const start = await config(["get", "date"], context);
        entry.timestamp = Math.floor((Date.now() - start) / 1000);
      }

      // Ensure all fields are provided
      for (const key in entry) {
        if (entry[key] === undefined) throw new UtilError("ERR_ARGS", args, context);
      }

      // Encode entry
      const categoryList = await categories(["list"], context);
      const buffer = encodeLogEntry(entry, categoryList);

      // Append entry to file
      appendFileSync(filePath, buffer);

      return "SUCCESS";

    }

    case "reconstruct": {

      const categoryList = await categories(["list"], context);
      const date = (await config(["get", "date"], context));
      const buffer = new Uint8Array(await file.arrayBuffer());

      // Parse weeklog
      const log = parseLog(buffer, categoryList);

      // Setup lb with categories
      const lb = {};
      for (let i = 0; i < categoryList.length; i ++) {
        lb[categoryList[i]] = [];
      }

      // Reconstruct each entry into the leaderboard in reverse chronological order
      for (let i = log.length - 1; i >= 0; i --) {

        // Skip if previous entry was already added
        const curr = log[i];
        if (lb[curr.category].find(entry => entry.steamid === curr.steamid)) continue;

        const newRun = {
          steamid: curr.steamid,
          time: curr.time,
          portals: curr.portals,
          date: curr.timestamp + date,
          note: ""
        };

        let inserted = false;

        // > The weeklog doesn't contain category data, so we don't know if a category is based in portals
        // > or not. Therefore, unfortunately, 'lp' is hardcoded to be least portals
        // - PancakeTAS

        // Insert 'lp' data into the leaderboard
        if (curr.category === "lp") {

          newRun.segmented = false;

          // Insert run at the correct position, based on portals
          for (let i = 0; i < lb[curr.category].length; i ++) {

            if (newRun.portals > lb[curr.category][i].portals) continue;

            if (newRun.portals === lb[curr.category][i].portals) {
              if (newRun.segmented && !lb[curr.category][i].segmented) continue;
              if (newRun.segmented === lb[curr.category][i].segmented) {
                if (newRun.time >= lb[curr.category][i].time) continue;
              }
            }

            lb[curr.category].splice(i, 0, newRun);
            inserted = true;
            break;

          }

        } else {

          // Insert the run without portals data
          delete newRun.portals;

          for (let i = 0; i < lb[curr.category].length; i ++) {

            if (newRun.time >= lb[curr.category][i].time) continue;

            lb[curr.category].splice(i, 0, newRun);
            inserted = true;
            break;

          }

        }

        // If the run was not inserted, add it to the end
        if (!inserted) lb[curr.category].push(newRun);

      }

      return lb;

    }

  }

  throw new UtilError("ERR_COMMAND", args, context);

};
