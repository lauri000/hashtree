export type PathEntryKind = 'file' | 'directory';
export interface PathMergeEntry<T> {
    path: string;
    kind: PathEntryKind;
    value: T;
}
export interface PathTombstone {
    path: string;
}
export interface PathMergeSource<T> {
    name: string;
    precedence?: number;
    entries: Iterable<PathMergeEntry<T>>;
    tombstones?: Iterable<PathTombstone>;
}
export type HiddenReason = 'shadowed' | 'tombstoned';
export interface HiddenPath {
    path: string;
    kind: PathEntryKind;
    source: string;
    reason: HiddenReason;
    bySource: string;
}
export interface MergedPathEntry<T> {
    path: string;
    kind: PathEntryKind;
    value: T;
    source: string;
}
export interface PathMergeResult<T> {
    entries: MergedPathEntry<T>[];
    hidden: HiddenPath[];
}
export declare class PathMergeError extends Error {
    constructor(message: string);
}
export declare function mergePathSources<T>(sources: Iterable<PathMergeSource<T>>): PathMergeResult<T>;
//# sourceMappingURL=index.d.ts.map