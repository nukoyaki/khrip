import { chromium } from "playwright";
import { JSDOM } from "jsdom";
import fs from "fs";
import { join } from "node:path";
import filenamify from "filenamify";
import pLimit from "p-limit";

const commandLineArguments = process.argv.slice(2);
const downloadAlbum = commandLineArguments[0];

if (!downloadAlbum) {
	console.error("please provide khinsider album URL");
	process.exit(1);
}

const folderName = decodeURIComponent(downloadAlbum.split("/").pop());
const folderPath = join("khinsider", folderName);

console.log("creating folder");
fs.mkdirSync(folderPath, { recursive: true });

const preferredFormats = ["flac", "wav", "ogg", "m4a", "mp3"];

function toArray(weirdShit) {
	return Array.prototype.slice.call(weirdShit);
}

function getFileExtension(link) {
	const lastDotIndex = link.lastIndexOf(".");
	return lastDotIndex === -1 ? "" : link.substring(lastDotIndex + 1);
}

function getFilesystemName(link) {
	link = decodeURIComponent(link);
	const lastSlashIndex = link.lastIndexOf("/");
	return lastSlashIndex === -1
		? "unknown"
		: link.substring(lastSlashIndex + 1);
}

(async () => {
	console.log("launching browser");
	const browser = await chromium.launch({ headless: true });
	const context = await browser.newContext({
		userAgent:
			"Mozilla/5.0 (X11; Linux x86_64; rv:156.0) Gecko/20100101 Firefox/156.0",
	});
	const page = await context.newPage();

	console.log(`fetching tracks from ${downloadAlbum}`);
	await page.goto(downloadAlbum, { waitUntil: "domcontentloaded" });

	try {
		await page.waitForSelector("#songlist", { timeout: 15000 });
	} catch (e) {
		console.error(
			"waiting for #songlist timed out, the script was either detected as a bot or the page layout changed",
		);
		await browser.close();
		process.exit(1);
	}

	const albumHtml = await page.content();
	const document = new JSDOM(albumHtml, { url: downloadAlbum }).window
		.document;

	const trackListTableElements = toArray(
		document.getElementById("songlist").getElementsByTagName("tbody")[0]
			.children,
	);

	const downloadPageLinks = [];

	trackListTableElements
		.slice(
			1, // cut off the header
			trackListTableElements.length - 1, // cut off the footer
		)
		.forEach((track) => {
			const playlistDownloadSong = track.getElementsByClassName(
				"playlistDownloadSong",
			)[0];
			if (playlistDownloadSong && playlistDownloadSong.childNodes[0]) {
				downloadPageLinks.push(playlistDownloadSong.childNodes[0].href);
			}
		});

	console.log(`got ${downloadPageLinks.length} track(s) to download`);

	const downloadLimit = pLimit(8);
	const metadataInput = [];

	console.log("downloading metadata");

	async function downloadFile(url, outputPath) {
		const response = await page.request.get(url);
		const buffer = await response.body();
		fs.writeFileSync(outputPath, buffer);
	}

	for (const albumArt of document.getElementsByClassName("albumImage")) {
		const artUrl = albumArt.children[0]?.href;
		if (artUrl) {
			metadataInput.push(
				downloadLimit(async () => {
					const outputPath = join(
						folderPath,
						filenamify(getFilesystemName(artUrl)),
					);
					await downloadFile(artUrl, outputPath);
				}),
			);
		}
	}

	for (const link of document.getElementsByTagName("a")) {
		if (link.href.match("khinsider.info.txt")) {
			metadataInput.push(
				downloadLimit(async () => {
					const outputPath = join(
						folderPath,
						filenamify(getFilesystemName(link.href)),
					);
					await downloadFile(link.href, outputPath);
				}),
			);
		}
	}

	await Promise.all(metadataInput);

	console.log("downloading songs");

	let downloadedSongs = 0;
	const songsToDownload = downloadPageLinks.length;
	const limitInput = [];

	for (const trackLink of downloadPageLinks) {
		limitInput.push(
			downloadLimit(async () => {
				const songPageResponse = await page.request.get(trackLink);
				const songPageHtml = await songPageResponse.text();

				const songDoc = new JSDOM(songPageHtml, { url: trackLink })
					.window.document;

				const formats = {};
				toArray(
					songDoc.getElementsByClassName("songDownloadLink"),
				).forEach((download) => {
					const href = download.parentNode.href;
					formats[getFileExtension(href)] = href;
				});

				let formatToUse = undefined;
				for (const format of preferredFormats) {
					if (
						formatToUse === undefined &&
						formats[format] !== undefined
					) {
						formatToUse = format;
						break;
					}
				}

				if (!formatToUse) {
					throw new Error(
						`unable to resolve format for track: ${trackLink}`,
					);
				}

				const songFileUrl = formats[formatToUse];
				const outputPath = join(
					folderPath,
					filenamify(getFilesystemName(songFileUrl)),
				);

				await downloadFile(songFileUrl, outputPath);

				downloadedSongs++;
				console.log(
					`downloading songs (${downloadedSongs}/${songsToDownload})`,
				);
			}),
		);
	}

	await Promise.all(limitInput);

	console.log("downloaded songs");
	await browser.close();
})();
