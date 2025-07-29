import React, { Component } from "react";
import { ImageProperties, ImageURISource } from "react-native";
export interface CachedImageURISource extends ImageURISource {
    uri: string;
}
export declare type CacheEntry = {
    source: CachedImageURISource;
    handlers: CacheHandler[];
    path: string | undefined;
    immutable: boolean;
    task?: any;
};
export declare type CacheHandler = (path: string) => void;
export declare type UriMapper = (uri: string) => string;
export declare class ImageCache {
    private getPath;
    private static instance;
    private constructor();
    static get(): ImageCache;
    private cache;
    private uriMapper;
    setUriMapper(p_fUriMapper: UriMapper): void;
    clearUriMapper(): void;
    cacheUri(uri: string): Promise<unknown>;
    clear(): any;
    on(source: CachedImageURISource, handler: CacheHandler, immutable?: boolean): void;
    dispose(uri: string, handler: CacheHandler): void;
    bust(uri: string): void;
    cancel(uri: string): void;
    private download;
    private get;
    private notify;
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
    private handler;
    private dispose;
    private observe;
    protected getProps(): any;
    private checkSource;
    UNSAFE_componentWillMount(): void;
    UNSAFE_componentWillReceiveProps(nextProps: P): void;
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
