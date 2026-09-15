import React, { Component } from "react";
import { ImageProperties, ImageURISource } from "react-native";
export type ImageCacheOptions = {
    maxConcurrentDownload?: number;
    maxConcurrentPriorityDownload?: number;
    connectionTimeout?: number;
    readTimeout?: number;
    totalTimeout?: number;
    maxRetryCount?: number;
    retryDelay?: number;
    componentMaxRetry?: number;
    componentRetryDelay?: number;
};
export interface CachedImageURISource extends ImageURISource {
    uri: string;
}
export type CacheEntry = {
    source: CachedImageURISource;
    handlers: CacheHandler[];
    errorHandlers: CacheErrorHandler[];
    path: string | undefined;
    immutable: boolean;
    task?: any;
    downloading: boolean;
    retryCount: number;
    priority: boolean;
};
export type CacheHandler = (path: string) => void;
export type CacheErrorHandler = (uri: string, error: Error) => void;
export type UriMapper = (uri: string) => string;
export declare class ImageCache {
    private getPath;
    private static instance;
    private constructor();
    static get(): ImageCache;
    private cache;
    private uriMapper;
    private pendingQueue;
    private activeDownloadCount;
    setOptions(p_oOptions?: ImageCacheOptions): void;
    setUriMapper(p_fUriMapper: UriMapper): void;
    clearUriMapper(): void;
    cacheUri(uri: string, p_bPriority?: boolean): Promise<string | undefined>;
    clear(): any;
    on(source: CachedImageURISource, handler: CacheHandler, immutable?: boolean, errorHandler?: CacheErrorHandler, priority?: boolean): void;
    dispose(uri: string, handler: CacheHandler, errorHandler?: CacheErrorHandler): void;
    bust(uri: string): void;
    cancel(uri: string): void;
    private download;
    private enqueue;
    private get;
    private notify;
    private notifyError;
    private onDownloadFailed;
    private promote;
    private pump;
    private removeStaleTempFiles;
}
export interface CachedImageProps extends ImageProperties {
    mutable?: boolean;
    children?: React.ReactNode;
}
export interface CustomCachedImageProps extends CachedImageProps {
    component: new () => Component<any, any>;
}
export interface CachedImageState {
    path: string | undefined;
}
export declare abstract class BaseCachedImage<P extends CachedImageProps> extends Component<P, CachedImageState> {
    private uri;
    private retryCount;
    private retryTimer;
    private brokenPath;
    private mounted;
    private handler;
    private errorHandler;
    private imageErrorHandler;
    private clearRetryTimer;
    private dispose;
    private observe;
    protected getProps(): any;
    private checkSource;
    UNSAFE_componentWillMount(): void;
    UNSAFE_componentWillReceiveProps(nextProps: P): void;
    componentDidMount(): void;
    componentWillUnmount(): void;
}
export declare class CachedImage extends BaseCachedImage<CachedImageProps> {
    render(): React.JSX.Element | null;
}
export declare class CachedImageBackground extends BaseCachedImage<CachedImageProps> {
    render(): React.JSX.Element | null;
}
export declare class CustomCachedImage<P extends CustomCachedImageProps> extends BaseCachedImage<P> {
    render(): React.JSX.Element | null;
}
