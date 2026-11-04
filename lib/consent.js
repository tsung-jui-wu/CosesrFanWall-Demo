import { HARD_CAP_DAYS } from './store.js';
import { LANGS, isLang } from '../public/js/i18n-core.js';

// v2: the v1 English wording, unchanged, plus Simplified and Traditional Chinese. Each submission
// stores this version and the language the fan read it in. Bump it whenever any wording changes.
export const CONSENT_VERSION = '2026-11-v2';

// Shown in full on the fan page, above the checkbox. Keep it short and plain.
// The Chinese versions are drafts that need a native reader's review before the real deploy
// (Simplified with mainland usage, Traditional with Taiwan usage), most of all the age line in the
// checkbox and the bystanders line. "Mosaic" is 照片拼贴 / 照片拼貼 on purpose: 马赛克 / 馬賽克
// usually means the blur used to censor a picture.
const COPY = {
  en: (who, days) => ({
    title: 'Before you send',
    points: [
      { h: 'What you are sharing', t: `The photo and/or message you submit, plus a name only if you choose to type one. No account, email, or location is collected, and photos are re-saved without their hidden location data.` },
      { h: 'Who sees it', t: `The event organizer reviews everything first. Approved items go to ${who}, who keeps them as a thank-you gallery. Your photo may appear as one small tile inside a mosaic, and ${who} may post the finished mosaic image on their social accounts.` },
      { h: 'Control', t: `${who} can hide or remove anything at any time, and can ask for the whole page to be wiped. You can delete your own submission whenever you like with the delete code shown after you send.` },
      { h: 'How long it is kept', t: `Everything is deleted automatically ${days} days after the event closes, and never kept longer than ${HARD_CAP_DAYS} days.` },
      { h: 'Please', t: `Only upload photos you took or have permission to share, and avoid photos where bystanders are the main subject.` },
    ],
    checkbox: `I took this photo or have permission to share it, I am 13 or older (or have a parent's OK), and I agree to the above.`,
  }),
  'zh-Hans': (who, days) => ({
    title: '发送前请先阅读',
    points: [
      { h: '你分享的内容', t: `你提交的照片和/或留言；只有在你自己填写时，才会附上名字。我们不收集账号、邮箱或位置信息，照片也会重新保存，去除其中隐藏的位置数据。` },
      { h: '谁会看到', t: `活动主办方会先审核所有内容。审核通过的内容会发送给${who}，作为感谢相册保存。你的照片可能会成为照片拼贴中的一小块，${who}也可能把完成的拼贴图片发布到自己的社交账号上。` },
      { h: '你可以控制', t: `${who}可以随时隐藏或删除任何内容，也可以要求清空整个页面。你也可以随时用发送后显示的删除码，删除自己提交的内容。` },
      { h: '保存多久', t: `所有内容会在活动结束 ${days} 天后自动删除，最长保存不超过 ${HARD_CAP_DAYS} 天。` },
      { h: '请注意', t: `请只上传你自己拍摄或已获得分享许可的照片，并避免以路人为主要拍摄对象的照片。` },
    ],
    checkbox: `这张照片是我拍的，或我已获得分享许可；我已年满 13 周岁（或已征得家长同意），并同意以上内容。`,
  }),
  'zh-Hant': (who, days) => ({
    title: '送出前請先閱讀',
    points: [
      { h: '你分享的內容', t: `你送出的照片和／或留言；只有在你自己填寫時，才會附上名字。我們不會收集帳號、電子郵件或位置資訊，照片也會重新存檔，移除檔案中隱藏的位置資訊。` },
      { h: '誰會看到', t: `活動主辦單位會先審核所有內容。通過審核的內容會送給${who}，留作感謝相簿。你的照片可能會成為照片拼貼中的一小格，${who}也可能把完成的拼貼圖片發布在自己的社群帳號上。` },
      { h: '你可以控制', t: `${who}隨時可以隱藏或刪除任何內容，也可以要求清空整個頁面。你也可以隨時用送出後顯示的刪除碼，刪除自己送出的內容。` },
      { h: '保存多久', t: `所有內容會在活動結束 ${days} 天後自動刪除，最長不會保存超過 ${HARD_CAP_DAYS} 天。` },
      { h: '請注意', t: `請只上傳你自己拍攝、或已取得分享許可的照片，並避免以路人為主要拍攝對象的照片。` },
    ],
    checkbox: `這張照片是我拍的，或我已取得分享許可；我已年滿 13 歲（或已取得家長同意），並同意以上內容。`,
  }),
};
const SOMEONE = { en: 'the cosplayer', 'zh-Hans': '这位 Coser', 'zh-Hant': '這位 Coser' };

export function consentCopy({ cosplayerName, retentionDays, lang = 'en' }) {
  const l = isLang(lang) ? lang : 'en';
  return { version: CONSENT_VERSION, lang: l, ...COPY[l](cosplayerName || SOMEONE[l], retentionDays) };
}

// All three, so the fan page can switch language without asking again.
export const consentCopies = (opts) => Object.fromEntries(LANGS.map((lang) => [lang, consentCopy({ ...opts, lang })]));
