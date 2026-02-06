'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArchitectureDiagram } from './ArchitectureDiagram';

export function MarkdownContent({ content }: { content: string }) {
  return (
    <article>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="text-xl text-white mb-6">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-white text-lg mt-10 mb-4 pb-2 border-b border-gray-800">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-white mt-6 mb-2">{children}</h3>
          ),
          p: ({ children }) => (
            <p className="text-gray-400 text-sm leading-relaxed mb-4">{children}</p>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target={href?.startsWith('http') ? '_blank' : undefined}
              rel={href?.startsWith('http') ? 'noopener noreferrer' : undefined}
              className="text-purple-400 hover:underline"
            >
              {children}
            </a>
          ),
          ul: ({ children }) => (
            <ul className="text-gray-400 text-sm mb-4 ml-4 list-disc list-outside space-y-1">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="text-gray-400 text-sm mb-4 ml-4 list-decimal list-outside space-y-1">
              {children}
            </ol>
          ),
          code: ({ className, children }) => {
            const isBlock = className?.includes('language-');
            if (isBlock) {
              return (
                <code className="block bg-gray-950 p-3 text-xs text-gray-300 overflow-x-auto mb-4">
                  {children}
                </code>
              );
            }
            return (
              <code className="bg-gray-900 px-1 text-gray-300 text-xs">
                {children}
              </code>
            );
          },
          pre: ({ children }) => <pre className="mb-4">{children}</pre>,
          strong: ({ children }) => (
            <strong className="text-white">{children}</strong>
          ),
          hr: () => <hr className="border-gray-800 my-8" />,
          table: ({ children }) => (
            <div className="overflow-x-auto mb-4">
              <table className="text-sm border-collapse border border-gray-800">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-gray-900">{children}</thead>
          ),
          tbody: ({ children }) => <tbody>{children}</tbody>,
          tr: ({ children }) => (
            <tr className="border-b border-gray-800 last:border-b-0">{children}</tr>
          ),
          th: ({ children }) => (
            <th className="text-left text-gray-400 py-2 px-3 font-normal border-r border-gray-800 last:border-r-0">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="text-gray-300 py-2 px-3 border-r border-gray-800 last:border-r-0">{children}</td>
          ),
          img: ({ src, alt }) => {
            if (src === '/diagram.svg') {
              return <ArchitectureDiagram />;
            }
            return <img src={src} alt={alt || ''} className="my-6 max-w-full" />;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </article>
  );
}
