'use strict';

/*
 * Minimal stand-in for the `obsidian` module so the pure logic in main.js can
 * be unit tested with plain Node (`node --test`). Only the pieces that are
 * touched at module load time matter; everything else is a harmless stub.
 */

class Base { constructor() {} }
class MarkdownView extends Base {}

class Setting extends Base {
	constructor() { super(); }
	setName() { return this; }
	setDesc() { return this; }
	setHeading() { return this; }
	addText() { return this; }
	addTextArea() { return this; }
	addButton() { return this; }
	addDropdown() { return this; }
	addToggle() { return this; }
	addExtraButton() { return this; }
	setValue() { return this; }
	setPlaceholder() { return this; }
	setButtonText() { return this; }
	setTooltip() { return this; }
	setCta() { return this; }
	setDisabled() { return this; }
	onChange() { return this; }
	onClick() { return this; }
}

function Notice() {}
function setIcon() {}
function normalizePath(p) { return String(p).replace(/\\/g, '/'); }
async function requestUrl() { return { status: 200, text: '', json: null, arrayBuffer: new ArrayBuffer(0) }; }

const Platform = { isDesktop: true, isMobile: false, isDesktopApp: true, isMobileApp: false };

module.exports = {
	Plugin: Base,
	ItemView: Base,
	PluginSettingTab: Base,
	Modal: Base,
	Setting,
	MarkdownView,
	Notice,
	setIcon,
	normalizePath,
	requestUrl,
	Platform,
};
