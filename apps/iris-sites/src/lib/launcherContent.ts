export const IRIS_OWNER = 'npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm';
const ENSHITTIFIER_NHASH = 'nhash1qqsxyn0g6yyac8ruej7r7j80y2gx6ev5z5flu6ry5h5t3ajju5utzjs9yz7t3p2syr9n5heajlv85uwej232dk5x4zqe8d7ft67y3m5umxr55qjku38';

export const HASHTREE_INSTALL_DOCS_HREF = `https://git.iris.to/#/${IRIS_OWNER}/hashtree/README.md`;
export const PUBLISH_IMMUTABLE_COMMAND = 'htree add ./dist';
export const PUBLISH_MUTABLE_COMMAND = 'htree add ./dist --publish my-site';

export const launcherSuggestions = [
  {
    name: 'MIDI Enshittifier',
    href: `#/${IRIS_OWNER}/enshittifier/index.html`,
    blurb: 'Mutable site route',
  },
  {
    name: 'Iris Files',
    href: `#/${IRIS_OWNER}/files/index.html`,
    blurb: 'Files and trees',
  },
  {
    name: 'Iris Git',
    href: `#/${IRIS_OWNER}/git/index.html`,
    blurb: 'Repos on hashtree',
  },
  {
    name: 'Iris Boards',
    href: `#/${IRIS_OWNER}/boards/index.html`,
    blurb: 'Shared boards',
  },
  {
    name: 'Iris Meet',
    href: `#/${IRIS_OWNER}/meet/index.html`,
    blurb: 'Video rooms',
  },
  {
    name: 'Pinned MIDI',
    href: `#/${ENSHITTIFIER_NHASH}/index.html`,
    blurb: 'Immutable nhash route',
  },
] as const;
