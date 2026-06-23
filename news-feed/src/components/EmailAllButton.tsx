import { buildMailto } from '../services/buildMailto';

interface EmailAllButtonProps {
  articles: { id: string; title: string; url: string }[];
  getTitle: (id: string) => string | null;
}

/**
 * "Email all" action for the saved view — opens the default mail client
 * pre-filled with every saved page via a dependency-free `mailto:` link.
 */
export function EmailAllButton({ articles, getTitle }: EmailAllButtonProps) {
  const openMail = () => {
    window.location.href = buildMailto(
      articles.map(a => ({ title: getTitle(a.id) || a.title, url: a.url })),
    );
  };
  return (
    <button className="btn-clear-queue" onClick={openMail}>
      Email all
    </button>
  );
}
