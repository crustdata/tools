// Email providers whose addresses say nothing about the company. A row with one of these gets no company from the
// address (the person can still be matched, and their current employer fills the company columns).

const LIST = `
gmail.com googlemail.com yahoo.com yahoo.co.uk yahoo.fr yahoo.de yahoo.es yahoo.it yahoo.ca yahoo.com.au yahoo.co.in yahoo.co.jp
ymail.com rocketmail.com hotmail.com hotmail.co.uk hotmail.fr hotmail.de hotmail.es hotmail.it outlook.com outlook.fr outlook.de
outlook.es outlook.jp live.com live.co.uk live.fr live.de live.nl msn.com aol.com icloud.com me.com mac.com protonmail.com
protonmail.ch proton.me pm.me gmx.com gmx.de gmx.net gmx.at gmx.ch mail.com email.com yandex.com yandex.ru ya.ru zoho.com
zohomail.com fastmail.com fastmail.fm hey.com qq.com foxmail.com 163.com 126.com sina.com sohu.com rediffmail.com web.de
t-online.de freenet.de orange.fr wanadoo.fr free.fr laposte.net sfr.fr bbox.fr btinternet.com sky.com virginmedia.com
talktalk.net comcast.net verizon.net att.net sbcglobal.net cox.net charter.net earthlink.net tutanota.com tuta.io duck.com
inbox.com mail.ru bk.ru list.ru inbox.ru naver.com daum.net hanmail.net nate.com libero.it virgilio.it tiscali.it alice.it
seznam.cz centrum.cz wp.pl o2.pl onet.pl interia.pl ukr.net i.ua bigpond.com optusnet.com.au iinet.net.au shaw.ca rogers.com
sympatico.ca telus.net bell.net videotron.ca uol.com.br bol.com.br terra.com.br ig.com.br globo.com hushmail.com
posteo.de mailbox.org runbox.com zoho.in rambler.ru example.com example.org example.net
`;

export const PERSONAL_DOMAINS: ReadonlySet<string> = new Set(LIST.split(/\s+/).filter(Boolean));

export const isPersonalDomain = (domain: string): boolean => PERSONAL_DOMAINS.has(domain.toLowerCase());

/** Hosts that serve many unrelated companies: a domain under one of these never counts as "a subdomain of the company's own domain". */
export const PLATFORM_HOSTS: ReadonlySet<string> = new Set(`
herokuapp.com vercel.app netlify.app github.io gitlab.io pages.dev web.app firebaseapp.com appspot.com azurewebsites.net
cloudfront.net amazonaws.com wordpress.com wixsite.com wix.com squarespace.com webflow.io framer.website framer.app
myshopify.com notion.site super.site carrd.co godaddysites.com weebly.com blogspot.com medium.com substack.com
hubspotpagebuilder.com hubspot.com linktr.ee bio.link google.com sites.google.com typeform.com
`.split(/\s+/).filter(Boolean));
