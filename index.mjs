import { JSDOM } from "jsdom";
import fs from "fs";
import https from "https";
import { join } from "node:path";
import filenamify from "filenamify";
import pLimit from "p-limit";

const commandLineArguments = process.argv.slice(2);
const downloadAlbum = commandLineArguments[0];
const folderPath = join("khinsider", getFilesystemName(downloadAlbum));

console.log("creating folder");
fs.mkdirSync(folderPath);

const preferredFormats = ["flac", "wav", "ogg", "m4a", "mp3"];

function toArray(weirdShit) {
	return Array.prototype.slice.call(weirdShit);
}

function getFileExtension(link) {
	const lastDotIndex = link.lastIndexOf(".");
	if (lastDotIndex === -1) {
		return ""; // No extension found
	}
	return link.substring(lastDotIndex + 1);
}

function getFilesystemName(link) {
	link = decodeURIComponent(link);

	const lastSlashIndex = link.lastIndexOf("/");
	if (lastSlashIndex === -1) {
		return "unknown"; // No name found
	}
	return link.substring(lastSlashIndex + 1);
}

function downloadMetadata(downloadLink) {
	return new Promise(async (resolve, reject) => {
		const file = fs.createWriteStream(
			join(folderPath, filenamify(getFilesystemName(downloadLink)))
		);

		https.get(downloadLink, (response) => {
			response.pipe(file);

			file.on("finish", () => {
				file.close();
				resolve();
			});
		});
	});
}

let downloadedSongs = 0;
let songsToDownload = 0;

function downloadSong(downloadLink) {
	return new Promise(async (resolve, reject) => {
		const document = new JSDOM(await (await fetch(downloadLink)).text(), {
			url: downloadLink,
		}).window.document;

		const formats = {};
		toArray(document.getElementsByClassName("songDownloadLink")).forEach(
			(download) => {
				formats[getFileExtension(download.parentNode.href)] =
					download.parentNode.href;
			}
		);

		let formatToUse = undefined;

		for (const format of preferredFormats) {
			if (formatToUse === undefined && formats[format] !== undefined) {
				formatToUse = format;
				break;
			}
		}

		if (!formatToUse) {
			reject(
				`unable to resolve formatToUse from preferredFormats, got formats: ${formats}`
			);
		}

		const file = fs.createWriteStream(
			join(
				folderPath,
				filenamify(getFilesystemName(formats[formatToUse]))
			)
		);

		https.get(formats[formatToUse], (response) => {
			response.pipe(file);

			file.on("finish", () => {
				downloadedSongs++;
				console.log(
					`downloading songs (${downloadedSongs}/${songsToDownload})`
				);

				file.close();
				resolve();
			});
		});
	});
}

console.log(`fetching tracks from ${downloadAlbum}`);

fetch(downloadAlbum).then(async (fetched) => {
	const document = new JSDOM(await fetched.text(), {
		url: downloadAlbum,
	}).window.document;

	const trackListTableElements = toArray(
		document.getElementById("songlist").getElementsByTagName("tbody")[0]
			.children
	);

	const downloadPageLinks = [];

	trackListTableElements
		.slice(
			1, // cut off the header
			trackListTableElements.length - 1 // cut off the footer
		)
		.forEach((track) => {
			downloadPageLinks.push(
				track.getElementsByClassName("playlistDownloadSong")[0]
					.childNodes[0].href
			);
		});

	console.log(`got ${downloadPageLinks.length} track(s) to download`);

	const downloadLimit = pLimit(8);
	const metadataInput = [];

	console.log("downloading metadata");

	for (const albumArt of document.getElementsByClassName("albumImage")) {
		metadataInput.push(downloadLimit(() => downloadMetadata(albumArt.children[0].href)));
	}

	for (const link of document.getElementsByTagName("a")) {
		if (link.href.match("khinsider.info.txt")) {
			metadataInput.push(downloadLimit(() => downloadMetadata(link.href)));
		}
	}

	await Promise.all(metadataInput);

	console.log("downloading songs");

	const limitInput = [];

	songsToDownload = downloadPageLinks.length;

	for (const track of downloadPageLinks) {
		limitInput.push(downloadLimit(() => downloadSong(track)));
	}

	await Promise.all(limitInput);

	console.log("downloaded songs");
});
