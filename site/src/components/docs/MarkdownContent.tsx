'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

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
            <h2 className="text-white text-lg mt-10 mb-4 pb-2 border-b border-[#333]">{children}</h2>
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
              className="text-[#A855F7] hover:underline"
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
                <code className="block bg-[#0f0f0f] p-3 text-xs text-gray-300 overflow-x-auto mb-4">
                  {children}
                </code>
              );
            }
            return (
              <code className="bg-[#1a1a1a] px-1 text-gray-300 text-xs">
                {children}
              </code>
            );
          },
          pre: ({ children }) => <pre className="mb-4">{children}</pre>,
          strong: ({ children }) => (
            <strong className="text-white">{children}</strong>
          ),
          hr: () => <hr className="border-[#222] my-8" />,
          table: ({ children }) => (
            <div className="overflow-x-auto mb-4">
              <table className="text-sm border-collapse border border-[#333] rounded">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-[#1a1a1a]">{children}</thead>
          ),
          tbody: ({ children }) => <tbody>{children}</tbody>,
          tr: ({ children }) => (
            <tr className="border-b border-[#333] last:border-b-0">{children}</tr>
          ),
          th: ({ children }) => (
            <th className="text-left text-gray-400 py-2 px-3 font-normal border-r border-[#333] last:border-r-0">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="text-gray-300 py-2 px-3 border-r border-[#333] last:border-r-0">{children}</td>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </article>
  );
}
