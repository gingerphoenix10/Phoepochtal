const { $ } = require("bun");
const fs = require("node:fs");
const UtilPrint = require("../util/print.js");
const tmppath = require("../util/tmppath.js");
const archive = require("../util/archive.js");
const gamefiles = require("../util/gamefiles.js");
const spplice = require("../util/spplice.js");
const workshopper = require("../util/workshopper.js");
const flush = require("../util/flush.js");
const discord = require("../util/discord.js");
const demo = require("../util/demo.js");
const testcvar = require("../util/testcvar.js");
const categories = require("../util/categories.js");
const users = require("../util/users.js");
const profiledata = require("../util/profiledata.js");
const profilelog = require("../util/profilelog.js");
const points = require("../util/points.js");
const curator = require("../util/curator.js");

// Scheduled routines are designed to revert all changes upon failing or to fail invisibly
// This causes messy try/catches, but is better than leaving the system in a half-broken state

async function concludeWeek (context) {

  const week = context.data.week;

  week.voting = false;
  week.bonus = true;
  
  for (let i = 0; i < week.categories.length; i ++) {
    week.categories[i].lock = true;
  }
  
  await points(["award"], context);

  await discord(["announce", "The leaderboard has been locked."], context);

  const { summary, timescales } = await summarizeDemoEvents(context);

  let textSummary = "## [ Demo event summary ]\n";
  for (let i = 0; i < summary.length; i ++) {
    textSummary += `\`${summary[i].cvar}\` in ${summary[i].count} demo${summary[i].count === 1 ? "" : "s"}: \`\`\`json\n${JSON.stringify(summary[i].demos)}\`\`\`\n`;
  }
  if (summary.length === 0) textSummary += "*All demos clean, nothing to report.*";

  let textTimescales = "## [ Demo timescale summary ]\n";
  for (let i = 0; i < timescales.length; i ++) {
    textTimescales += `\`${timescales[i].average.toFixed(5)}\` average in \`${timescales[i].demo}\`:\`\`\`json\n${JSON.stringify(timescales[i].array)}\`\`\`\n`;
  }
  if (timescales.length === 0) textTimescales += "*All demos clean, nothing to report.*";

  const finalReportText = `${textSummary}\n${textTimescales}`;
  UtilPrint("epochtal(concludeWeek):\n" + finalReportText);
  await discord(["report", finalReportText], context);

  await Bun.write(context.file.week, JSON.stringify(week));

  // Parse suggested maps (remove those which have been picked)
  const suggestions = await Bun.file(`${__dirname}/../suggestions.json`).json();
  for (let i = 0; i < suggestions.length; i ++) {
    if (!("v1" in suggestions[i] && "v2" in suggestions[i])) {
      suggestions.splice(i, 1);
      i --;
    }
  }

  // Curate a week's worth of workshop maps
  UtilPrint("epochtal(concludeWeek): Ensuring that v2 density graphs are up to date...");
  await curator(["graph"], context);

  UtilPrint("epochtal(concludeWeek): Curating workshop maps...");
  const allmaps = await workshopper(["curateweek", suggestions], context);
  await Bun.write(`${__dirname}/../maps.json`, JSON.stringify(allmaps));

  return "SUCCESS";

}

async function releaseMap (context) {

  UtilPrint("epochtal(releaseMap): Creating archive...");
  await archive(["create", null, true], context);

  // Load the curated workshop map set, pick 5 for voting
  const allmaps = await Bun.file(`${__dirname}/../maps.json`).json();
  const VOTING_MAPS_COUNT = 5;

  UtilPrint("epochtal(releaseMap): Building voting map list...");
  const votingmaps = [];
  for (let i = 0; i < allmaps.length; i ++) {

    const details = await workshopper(["get", allmaps[i].id]);
    if (votingmaps.find(curr => curr.author === details.author)) continue;
    
    votingmaps.push(details);
    if (votingmaps.length === VOTING_MAPS_COUNT) break;

  }

  // Create Spplice package for voting list maps
  UtilPrint("epochtal(releaseMap): Creating voting map Spplice package...");
  
  const votingContext = {
    data: { week: { number: ((context.data.week.number + 1) + "-voting"), map: votingmaps } },
    file: { portal2: context.file.portal2 }
  };

  let votingThumbnail = votingmaps[0].thumbnail;
  if (!votingThumbnail.startsWith("http")) {
    votingThumbnail = `https://steamuserimages-a.akamaihd.net/ugc/${votingThumbnail}?impolicy=Letterbox&imh=360`;
  }

  let sppliceVotingResult;
  try {

    if (await spplice(["get", "epochtal-voting"])) {
      await spplice(["remove", "epochtal-voting"]);
    }

    const votingFiles = await gamefiles(["build"], votingContext);

    // It doesn't make much sense for the voting package to start on the main menu
    const valveRC = Bun.file(`${votingFiles.output}/cfg/valve.rc`);
    const valveRCText = await valveRC.text();
    await Bun.write(valveRC, valveRCText.replace("startupmenu", "exec epochtal_map"));

    try {
    sppliceVotingResult = await spplice(["add",
      "epochtal-voting",
      votingFiles.output,
      `Tournament Week ${context.data.week.number + 1} Voting Pool`,
      "PortalRunner",
      votingThumbnail,
      "Play future maps ahead of time and vote for your favorites on the Epochtal website.",
      2995
    ]);
    } finally {
    fs.rmSync(votingFiles.output, { recursive: true });
    }

  } catch (e) {

    if (sppliceVotingResult) await spplice(["remove", "epochtal-voting"]);

    e.message = "ERR_VOTEFILES: " + e.message;
    throw e;

  }
  
  // Count votes and pick the next active map
  UtilPrint("epochtal(releaseMap): Counting map votes...");

  let newmap;
  try {

    const totalVotes = Array(VOTING_MAPS_COUNT).fill(0);
    const totalUpvotes = Array(VOTING_MAPS_COUNT).fill(0);
    const totalDownvotes = Array(VOTING_MAPS_COUNT).fill(0);
  
    for (const steamid in context.data.week.votes) {
  
      const curr = context.data.week.votes[steamid];
      
      for (let i = 0; i < VOTING_MAPS_COUNT; i ++) {
        if (curr[i] > 0) totalUpvotes[i] += curr[i];
        else if (curr[i] < 0) totalDownvotes[i] -= curr[i];
        totalVotes[i] += curr[i];
      }
  
    }
  
    let highestVoted = 0;
    for (let i = 1; i < VOTING_MAPS_COUNT; i ++) {
      if (totalVotes[i] > totalVotes[highestVoted]) {
        highestVoted = i;
      }
    }
  
    newmap = await workshopper(["get", context.data.week.votingmaps[highestVoted].id]);
    newmap.upvotes = totalUpvotes[highestVoted];
    newmap.downvotes = totalDownvotes[highestVoted];

  } catch (e) {

    await spplice(["remove", "epochtal-voting"]);

    e.message = "ERR_VOTEFILES: " + e.message;
    throw e;

  }

  // Build new game files and update Spplice repository
  UtilPrint(`epochtal(releaseMap): Building game files for map "${newmap.title}" by "${newmap.author}"...`);

  let sppliceResult = null;
  let announceText;

  try {

    context.data.week.number ++;
    context.data.week.map = newmap;

    announceText = `With a community vote of ${context.data.week.map.upvotes} upvotes to ${context.data.week.map.downvotes} downvotes, the map for week ${context.data.week.number} of PortalRunner's Weekly Tournament was decided to be ${context.data.week.map.title} by ${context.data.week.map.author}.`;

    let thumbnail = context.data.week.map.thumbnail;
    if (!thumbnail.startsWith("http")) {
      thumbnail = `https://steamuserimages-a.akamaihd.net/ugc/${thumbnail}?impolicy=Letterbox&imh=360`;
    }

    // If the routine fails somewhere here, we can't easily revert a Spplice package change
    // However, since the board would be locked by now, we can afford deleting the old package
    // The focus should be on not "leaking" the new package early
    if (await spplice(["get", "epochtal"])) {
      await spplice(["remove", "epochtal"]);
    }

    const portal2 = await gamefiles(["build"], context);
    const vmf = await gamefiles(["getvmf", `${portal2.output}/maps/${portal2.map[0]}`, true], context);
    
    try {
    sppliceResult = await spplice(["add",
      "epochtal",
      portal2.output,
      "Tournament Week " + context.data.week.number,
      "PortalRunner",
      thumbnail,
      announceText,
      3000
    ]);
    } finally {
    fs.rmSync(portal2.output, { recursive: true });
    }

    fs.renameSync(vmf, `${__dirname}/../vmfs/${context.data.week.map.id}.vmf.xz`);

    context.data.week.map.file = portal2.map[0];
  
  } catch (e) {

    await flush(["memory"], context);

    await spplice(["remove", "epochtal-voting"]);
    if (sppliceResult) await spplice(["remove", "epochtal"]);

    e.message = "ERR_GAMEFILES: " + e.message;
    throw e;

  }

  UtilPrint(`epochtal(releaseMap): Writing configuration for week ${context.data.week.number}...`);

  let weekString, leaderboardString;
  try {

    context.data.week.voting = true;
    context.data.week.bonus = false;
    context.data.week.date = Math.floor(Date.now() / 1000);
    context.data.week.votingmaps = votingmaps;
    context.data.week.votes = {};
    context.data.week.partners = {};

    for (let i = 0; i < context.data.week.categories.length; i ++) {
      context.data.week.categories[i].lock = false;
    }

    context.data.leaderboard = {};

    weekString = JSON.stringify(context.data.week);
    leaderboardString = JSON.stringify(context.data.leaderboard);
  
  } catch (e) {

    await flush(["memory"], context);

    await spplice(["remove", "epochtal-voting"]);
    await spplice(["remove", "epochtal"]);

    e.message = "ERR_WRITEMEM: " + e.message;
    throw e;

  }
  
  try {
    
    const suggestionsFile = Bun.file(`${__dirname}/../suggestions.json`);
    const suggestions = await suggestionsFile.json();

    for (const map of votingmaps) {
      const suggestion = suggestions.find(c => c.id === map.id);
      if (!suggestion) continue;

      delete suggestion.v1;
      delete suggestion.v2;
    }
    await Bun.write(suggestionsFile, JSON.stringify(suggestions));

  } catch (e) {

    await flush(["memory"], context);

    await spplice(["remove", "epochtal-voting"]);
    await spplice(["remove", "epochtal"]);

    e.message = "ERR_UPDATE_SUGGESTIONS: " + e.message;
    throw e;

  }

  await Bun.write(context.file.week, weekString);
  await Bun.write(context.file.leaderboard, leaderboardString);
  await Bun.write(context.file.log, "");

  await discord(["announce", announceText], context);

  return "SUCCESS";

}

async function rebuildMap (context) {

  const archivePath = `${__dirname}/../pages/epochtal.tar.xz`;
  const archiveBackup = await tmppath();

  let sppliceResult;
  try {

    let thumbnail = context.data.week.map.thumbnail;
    if (!thumbnail.startsWith("http")) {
      thumbnail = `https://steamuserimages-a.akamaihd.net/ugc/${thumbnail}?impolicy=Letterbox&imh=360`;
    }
    const announceText = `With a community vote of ${context.data.week.map.upvotes} upvotes to ${context.data.week.map.downvotes} downvotes, the map for week ${context.data.week.number} of PortalRunner's Weekly Tournament was decided to be ${context.data.week.map.title} by ${context.data.week.map.author}.`;

    if (await spplice(["get", "epochtal"])) {
      await spplice(["remove", "epochtal"]);
    }

    const portal2 = await gamefiles(["build"], context);
    sppliceResult = await spplice(["add",
      "epochtal",
      portal2.output,
      "Tournament Week " + context.data.week.number,
      "PortalRunner",
      thumbnail,
      announceText,
      100
    ]);
  
    fs.rmSync(portal2.output, { recursive: true });

  } catch (e) {

    if (sppliceResult) await spplice(["remove", "epochtal"]);

    e.message = "ERR_GAMEFILES: " + e.message;
    throw e;

  }

  return "SUCCESS";

}

const [VERDICT_SAFE, VERDICT_UNSURE, VERDICT_ILLEGAL] = [0, 1, 2];
async function summarizeDemoEvents (context) {

  const summary = {}, timescales = {};
  const files = fs.readdirSync(context.file.demos);

  for (let i = 0; i < files.length; i ++) {

    if (!files[i].endsWith(".dem.xz")) continue;

    const category = files[i].split("_")[1].split(".")[0];
    const categoryData = await categories(["get", category]);

    if (!categoryData.points && category !== "ppnf") continue;

    const xzFile = `${context.file.demos}/${files[i]}`;
    await $`xz -dkf ${xzFile}`.quiet();

    const file = `${context.file.demos}/${files[i].slice(0, -3)}`;
    const mdp = await demo(["mdp", file]);

    fs.unlinkSync(file);

    const fileNoExtension = files[i].slice(0, -7);

    for (const event of mdp.demos[0].events) {
      
      if (event.type === "timescale") {

        if (!(fileNoExtension in timescales)) {
          timescales[fileNoExtension] = { average: 0, array: [] };
        }

        const scale = Number(event.value);
        timescales[fileNoExtension].array.push(scale);
        timescales[fileNoExtension].average += scale;

        continue;

      }

      if (event.type !== "cvar" && event.type !== "cmd") continue;

      const cvar = event.type === "cvar" ? event.val.cvar : event.value.split(" ")[0];
      const value = event.type === "cvar" ? event.val.val : event.value.split(" ").slice(1).join(" ");

      const verdict = await testcvar([cvar, value], context);
      
      if (verdict !== VERDICT_SAFE) {

        if (cvar === "sv_portal_placement_never_fail" && files[i].endsWith("_ppnf.dem.xz")) {
          continue;
        }

        if (!(cvar in summary)) summary[cvar] = {
          count: 0,
          demos: []
        };

        summary[cvar].count ++;
        if (!summary[cvar].demos.includes(fileNoExtension)) {
          summary[cvar].demos.push(fileNoExtension);
        }

      }

    }

    if (fileNoExtension in timescales) {
      const unscaledTicks = mdp.demos[0].ticks - timescales[fileNoExtension].array.length;
      timescales[fileNoExtension].average += unscaledTicks;
      timescales[fileNoExtension].average /= mdp.demos[0].ticks;
    }

  }

  const sortedSummary = [];
  for (const cvar in summary) {
    summary[cvar].cvar = cvar;
    sortedSummary.push(summary[cvar]);
  }

  sortedSummary.sort(function (a, b) {
    return a.count - b.count;
  });

  const sortedTimescales = [];
  for (const demo in timescales) {
    timescales[demo].demo = demo;
    sortedTimescales.push(timescales[demo]);
  }

  sortedTimescales.sort(function (a, b) {
    return Math.abs(1.0 - b.average) - Math.abs(1.0 - a.average);
  });

  return {
    summary: sortedSummary,
    timescales: sortedTimescales
  }

}

async function rebuildProfiles (context) {

  const userList = await users(["list"], context);
  
  for (const steamid in userList) {
    await profiledata(["forceadd", steamid], context);
    await users(["apiupdate", steamid], context);
    await profilelog(["build", steamid], context);
  }

  await points(["rebuild"], context);

  return "SUCCESS";

}

module.exports = {
  releaseMap,
  rebuildMap,
  concludeWeek,
  summarizeDemoEvents,
  rebuildProfiles
};
