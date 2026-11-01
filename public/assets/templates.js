// Messages de relance. Le ton monte doucement avec le nombre de relances déjà faites.
import { dateLong, money2 } from './utils.js';

function stage(count) {
  if (count <= 0) return 1;
  if (count === 1) return 2;
  return 3;
}

/** Jours suggérés avant la prochaine relance, selon le nombre de relances faites avant celle-ci. */
export function suggestedNextDays(countBefore) {
  if (countBefore <= 0) return 7;
  if (countBefore === 1) return 14;
  return 0; // après le dernier suivi : pas de prochaine relance
}

export function buildMessage(q, { channel = 'email', signer = {}, link = '', kind = 'follow' } = {}) {
  const client = q.client.trim();
  const project = `«\u00a0${q.project.trim()}\u00a0»`; // espaces insécables : les guillemets ne se détachent pas
  const date = dateLong(q.sentOn);
  const name = (signer.displayName || '').trim();
  const company = (signer.company || '').trim();
  const phone = (signer.phone || '').trim();
  const s = stage(q.followUpCount || 0);
  const total = `${money2(q.amount)}${q.taxes ? ', taxes incluses' : ''}`;

  if (channel === 'sms') {
    const me = name ? `ici ${name}${company ? ` de ${company}` : ''}` : (company ? `ici ${company}` : '');
    const hello = `Bonjour ${client}${me ? `, ${me}` : ''}.`;
    if (kind === 'send') {
      return { subject: '', body: `${hello} Voici votre soumission pour ${project} (${total}) : ${link} Vous pouvez la consulter et l'accepter en ligne. Des questions? Répondez à ce message.` };
    }
    const body = {
      1: `${hello} Petit suivi pour la soumission ${project} envoyée le ${date}. Avez-vous des questions? Je peux vous appeler au moment qui vous convient.`,
      2: `${hello} Je reviens vers vous pour ${project}. Si le budget ou l'échéancier coince, on peut ajuster la soumission. Un appel cette semaine?`,
      3: `${hello} Dernier suivi pour ${project}. Si ça va de l'avant, faites-moi signe pour réserver une date. Sinon, un petit mot me permet de fermer le dossier. Merci!`,
    }[s];
    return { subject: '', body: link ? `${body} Votre soumission : ${link}` : body };
  }

  const signature = [name || '[Ton nom]', company, phone].filter(Boolean).join('\n');
  if (kind === 'send') {
    return {
      subject: `Votre soumission ${q.number ? `n° ${q.number} ` : ''}: ${project}`,
      body: `Bonjour ${client},

Merci de votre intérêt. Voici notre soumission pour ${project}, au montant de ${total}.

Vous pouvez la consulter, l'enregistrer en PDF et l'accepter en ligne :
${link}

Je reste disponible pour toute question.

Au plaisir,
${signature}`,
    };
  }
  const linkPara = link ? `\n\nLa soumission est accessible en ligne, où vous pouvez aussi l'accepter :\n${link}` : '';
  const bodies = {
    1: `Bonjour ${client},

Je fais un suivi concernant la soumission ${project} que je vous ai envoyée le ${date}.

Avez-vous eu la chance d'en prendre connaissance? Je suis disponible pour répondre à vos questions ou ajuster certains éléments au besoin.${linkPara}

Au plaisir,
${signature}`,
    2: `Bonjour ${client},

Je reviens vers vous au sujet de la soumission ${project}. Si le budget ou l'échéancier pose un défi, on peut regarder ensemble des options pour l'adapter.

Est-ce qu'un court appel cette semaine vous conviendrait?${linkPara}

Merci et bonne journée,
${signature}`,
    3: `Bonjour ${client},

Je me permets un dernier suivi pour la soumission ${project}. Je planifie mon calendrier des prochaines semaines : si le projet va de l'avant, faites-moi signe et on pourra réserver une date.

Si vous avez choisi une autre option, aucun souci. Un simple mot me permettra de fermer le dossier.${linkPara}

Bonne journée,
${signature}`,
  };
  return { subject: `Suivi de la soumission ${project}`, body: bodies[s] };
}

export function mailtoHref(email, subject, body) {
  return `mailto:${encodeURIComponent(email.trim())}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export function smsHref(phone, body) {
  const num = phone.replace(/[^\d+]/g, '');
  // « ?&body= » fonctionne sur iOS et Android.
  return `sms:${num}?&body=${encodeURIComponent(body)}`;
}
