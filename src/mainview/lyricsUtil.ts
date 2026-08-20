// Romaji transliteration and lyrics parsing utilities for Lakky 2026 Karaoke View

const HIRAGANA_MAP: Record<string, string> = {
	"きゃ": "kya", "きゅ": "kyu", "きょ": "kyo",
	"しゃ": "sha", "しゅ": "shu", "しょ": "sho",
	"ちゃ": "cha", "ちゅ": "chu", "ちょ": "cho",
	"にゃ": "nya", "にゅ": "nyu", "にょ": "nyo",
	"ひゃ": "hya", "ひゅ": "hyu", "ひょ": "hyo",
	"みゃ": "mya", "みゅ": "myu", "みょ": "myo",
	"りゃ": "rya", "りゅ": "ryu", "りょ": "ryo",
	"ぎゃ": "gya", "ぎゅ": "gyu", "ぎょ": "gyo",
	"じゃ": "ja",  "じゅ": "ju",  "じょ": "jo",
	"びゃ": "bya", "びゅ": "byu", "びょ": "byo",
	"ぴゃ": "pya", "ぴゅ": "pyu", "ぴょ": "pyo",
	"あ": "a", "い": "i", "う": "u", "え": "e", "お": "o",
	"か": "ka", "き": "ki", "く": "ku", "け": "ke", "こ": "ko",
	"さ": "sa", "し": "shi", "す": "su", "せ": "se", "そ": "so",
	"た": "ta", "ち": "chi", "つ": "tsu", "て": "te", "と": "to",
	"な": "na", "に": "ni", "ぬ": "nu", "ね": "ne", "の": "no",
	"は": "ha", "ひ": "hi", "ふ": "fu", "へ": "he", "ほ": "ho",
	"ま": "ma", "み": "mi", "む": "mu", "め": "me", "も": "mo",
	"や": "ya", "ゆ": "yu", "よ": "yo",
	"ら": "ra", "り": "ri", "る": "ru", "れ": "re", "ろ": "ro",
	"わ": "wa", "を": "wo", "ん": "n",
	"が": "ga", "ぎ": "gi", "ぐ": "gu", "げ": "ge", "ご": "go",
	"ざ": "za", "じ": "ji", "ず": "zu", "ぜ": "ze", "ぞ": "zo",
	"だ": "da", "ぢ": "ji", "づ": "zu", "で": "de", "ど": "do",
	"ば": "ba", "び": "bi", "ぶ": "bu", "べ": "be", "ぼ": "bo",
	"ぱ": "pa", "ぴ": "pi", "ぷ": "pu", "ぺ": "pe", "ぽ": "po",
	"ぁ": "a", "ぃ": "i", "ぅ": "u", "ぇ": "e", "ぉ": "o",
	"っ": "t",
};

const KATAKANA_MAP: Record<string, string> = {
	"キャ": "kya", "キュ": "kyu", "キョ": "kyo",
	"シャ": "sha", "シュ": "shu", "ショ": "sho",
	"チャ": "cha", "チュ": "chu", "チョ": "cho",
	"ニャ": "nya", "ニュ": "nyu", "ニョ": "nyo",
	"ヒャ": "hya", "ヒュ": "hyu", "ヒョ": "hyo",
	"ミャ": "mya", "ミュ": "myu", "ミョ": "myo",
	"リャ": "rya", "リュ": "ryu", "リョ": "ryo",
	"ギャ": "gya", "ギュ": "gyu", "ギョ": "gyo",
	"ジャ": "ja",  "ジュ": "ju",  "ジョ": "jo",
	"ビャ": "bya", "ビュ": "byu", "ビョ": "byo",
	"ピャ": "pya", "ピュ": "pyu", "ピョ": "pyo",
	"ア": "a", "イ": "i", "ウ": "u", "エ": "e", "オ": "o",
	"カ": "ka", "キ": "ki", "ク": "ku", "ケ": "ke", "コ": "ko",
	"サ": "sa", "シ": "shi", "ス": "su", "セ": "se", "ソ": "so",
	"タ": "ta", "チ": "chi", "ツ": "tsu", "テ": "te", "ト": "to",
	"ナ": "na", "ニ": "ni", "ヌ": "nu", "ネ": "ne", "ノ": "no",
	"ハ": "ha", "ヒ": "hi", "フ": "fu", "ヘ": "he", "ホ": "ho",
	"マ": "ma", "ミ": "mi", "ム": "mu", "メ": "me", "モ": "mo",
	"ヤ": "ya", "ユ": "yu", "ヨ": "yo",
	"ラ": "ra", "リ": "ri", "ル": "ru", "レ": "re", "ロ": "ro",
	"ワ": "wa", "ヲ": "wo", "ン": "n",
	"ガ": "ga", "ギ": "gi", "グ": "gu", "ゲ": "ge", "ゴ": "go",
	"ザ": "za", "ジ": "ji", "ズ": "zu", "ゼ": "ze", "ゾ": "zo",
	"ダ": "da", "ヂ": "ji", "ヅ": "zu", "デ": "de", "ド": "do",
	"バ": "ba", "ビ": "bi", "ブ": "bu", "ベ": "be", "ボ": "bo",
	"パ": "pa", "ピ": "pi", "プ": "pu", "ペ": "pe", "ポ": "po",
	"ァ": "a", "ィ": "i", "ゥ": "u", "ェ": "e", "ォ": "o",
	"ッ": "t", "ー": "-",
};

export type LyricMode = "original" | "romaji" | "dual";

export function containsJapanese(str: string): boolean {
	return /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(str);
}

export function toRomaji(input: string): string {
	let out = "";
	let i = 0;
	while (i < input.length) {
		const two = input.substring(i, i + 2);
		if (HIRAGANA_MAP[two]) {
			out += HIRAGANA_MAP[two];
			i += 2;
			continue;
		}
		if (KATAKANA_MAP[two]) {
			out += KATAKANA_MAP[two];
			i += 2;
			continue;
		}
		const one = input[i];
		if (HIRAGANA_MAP[one]) {
			out += HIRAGANA_MAP[one];
			i++;
			continue;
		}
		if (KATAKANA_MAP[one]) {
			out += KATAKANA_MAP[one];
			i++;
			continue;
		}
		out += one;
		i++;
	}
	return out;
}

export interface LyricLine {
	time: number;
	text: string;
	romaji?: string;
	translation?: string;
}

export function findActiveLyricIndex(lines: LyricLine[], currentTime: number): number {
	if (!lines || lines.length === 0) return -1;
	let low = 0;
	let high = lines.length - 1;
	let active = -1;

	while (low <= high) {
		const mid = (low + high) >> 1;
		if (lines[mid].time <= currentTime + 0.15) {
			active = mid;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	return active;
}
