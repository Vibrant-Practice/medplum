// @ts-check
// Note: type annotations allow type checking and IDEs autocompletion

const lightCodeTheme = require('prism-react-renderer/themes/github');
const darkCodeTheme = require('prism-react-renderer/themes/dracula');

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'Medplum',
  tagline: 'Healthcare infrastructure and application development',
  url: 'https://docs.medplum.com',
  baseUrl: '/',
  trailingSlash: false,
  onBrokenLinks: 'error',
  onBrokenMarkdownLinks: 'error',
  favicon: 'img/favicon.ico',
  organizationName: 'medplum', // Usually your GitHub org/user name.
  projectName: 'medplum', // Usually your repo name.

  presets: [
    [
      '@docusaurus/preset-classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          sidebarPath: require.resolve('./sidebars.js'),
          editUrl: 'https://github.com/medplum/medplum/blob/main/packages/docs/',
          routeBasePath: '/',
        },
        blog: {
          showReadingTime: true,
        },
        theme: {
          customCss: require.resolve('./src/css/custom.css'),
        },
      }),
    ],
  ],

  plugins: [['docusaurus-plugin-typedoc', { out: 'sdk', sidebar: { categoryLabel: 'SDK', position: 5 } }]],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      navbar: {
        title: 'Medplum',
        logo: {
          alt: 'Medplum Logo',
          src: 'img/logo.svg',
        },
        items: [
          {
            type: 'doc',
            docId: 'home',
            position: 'left',
            label: 'Docs',
          },
          {
            to: '/tutorials',
            label: 'Tutorials',
            position: 'left',
          },
          {
            to: '/api',
            label: 'API',
            position: 'left',
          },
          {
            to: '/contributing',
            label: 'Contributing',
            position: 'left',
          },
          {
            to: '/blog',
            label: 'Blog',
            position: 'left',
          },
          {
            href: 'https://github.com/medplum/medplum',
            label: 'GitHub',
            position: 'right',
          },
        ],
      },
      footer: {
        style: 'dark',
        links: [
          {
            title: 'Docs',
            items: [
              {
                label: 'Tutorial',
                to: '/tutorials',
              },
            ],
          },
          {
            title: 'Community',
            items: [
              {
                label: 'Stack Overflow',
                href: 'https://stackoverflow.com/questions/tagged/medplum',
              },
              {
                label: 'Discord',
                href: 'https://discord.gg/UBAWwvrVeN',
              },
              {
                label: 'Storybook',
                href: 'https://docs.medplum.com/storybook/index.html',
              },
            ],
          },
          {
            title: 'More',
            items: [
              {
                label: 'Blog',
                to: '/blog',
              },
              {
                label: 'GitHub',
                href: 'https://github.com/medplum/medplum',
              },
            ],
          },
        ],
        copyright: `Copyright © ${new Date().getFullYear()} Medplum, Inc.`,
      },
      prism: {
        theme: lightCodeTheme,
        darkTheme: darkCodeTheme,
      },
    }),
};

module.exports = config;
