import {
    COLLECTION_ROLE,
    CollectionType,
    type Collection,
} from "@/media/collection";
import type { EnteFile } from "@/media/file";
import { mergeMetadata } from "@/media/file";
import {
    createCollectionNameByID,
    isHiddenCollection,
} from "@/new/photos/services/collection";
import { splitByPredicate } from "@/utils/array";
import { ensure } from "@/utils/ensure";
import type { User } from "@ente/shared/user/types";
import { t } from "i18next";
import React, { useReducer } from "react";
import {
    ALL_SECTION,
    ARCHIVE_SECTION,
    DUMMY_UNCATEGORIZED_COLLECTION,
    findDefaultHiddenCollectionIDs,
    HIDDEN_ITEMS_SECTION,
    isDefaultHiddenCollection,
    isIncomingShare,
    TRASH_SECTION,
} from "../../services/collection";
import type {
    CollectionSummary,
    CollectionSummaryType,
} from "../../services/collection/ui";
import {
    createFileCollectionIDs,
    getLatestVersionFiles,
    groupFilesByCollectionID,
} from "../../services/file";
import { sortFiles } from "../../services/files";
import {
    isArchivedCollection,
    isArchivedFile,
    isPinnedCollection,
} from "../../services/magic-metadata";
import type { PeopleState, Person } from "../../services/ml/people";
import type { FamilyData } from "../../services/user";

/**
 * Specifies what the bar at the top of the gallery is displaying currently.
 *
 * TODO: Deprecated(?). Use GalleryView instead. Deprecated if it can be used in
 * all cases where the bar mode was in use.
 */
export type GalleryBarMode = "albums" | "hidden-albums" | "people";

/**
 * Specifies what the gallery is currently displaying.
 *
 * This can be overridden by the display of search results.
 */
export type GalleryView =
    | {
          /**
           * We're either in the "Albums" or "Hidden albums" section.
           */
          type: "albums" | "hidden-albums";
          activeCollectionSummaryID: number;
          /**
           * If the active collection ID is for a collection and not a
           * pseudo-collection, this property will be set to the corresponding
           * {@link Collection}.
           *
           * It is guaranteed that this will be one of the {@link collections}
           * or {@link hiddenCollections}.
           */
          activeCollection: Collection | undefined;
      }
    | {
          /**
           * We're in the "People" section.
           */
          type: "people";
          /**
           * The list of people to show in the gallery bar.
           *
           * Note that this can be different from the underlying list of
           * visiblePeople in the {@link peopleState}, and can temporarily
           * include a person from outside that list.
           */
          visiblePeople: Person[];
          /**
           * The currently selected person in the gallery bar, if any.
           *
           * It is guaranteed that when it is set, {@link activePerson} will be
           * one of the objects from among {@link people}.
           */
          activePerson: Person | undefined;
      };

/**
 * Derived UI state backing the gallery.
 *
 * This might be different from the actual different from the actual underlying
 * state since there might be unsynced data (hidden or deleted that have not yet
 * been synced with remote) that should be temporarily taken into account for
 * the UI state until the operation completes.
 */
export interface GalleryState {
    /*--<  Mostly static state  >--*/

    /**
     * The logged in {@link User}.
     *
     * This is expected to be undefined only for a brief duration until the code
     * for the initial "mount" runs (If we're not logged in, then the gallery
     * will redirect the user to an appropriate authentication page).
     */
    user: User | undefined;
    /**
     * Family plan related information for the logged in {@link User}.
     */
    familyData: FamilyData | undefined;

    /*--<  Primary state: Files, collections, people  >--*/

    /**
     * The user's non-hidden collections.
     */
    collections: Collection[];
    /**
     * The user's hidden collections.
     */
    hiddenCollections: Collection[];
    /**
     * The user's normal (non-hidden, non-trash) files.
     *
     * The list is sorted so that newer files are first.
     */
    files: EnteFile[];
    /**
     * The user's hidden files.
     *
     * The list is sorted so that newer files are first.
     */
    hiddenFiles: EnteFile[];
    /**
     * The user's files that are in Trash.
     *
     * The list is sorted so that newer files are first.
     */
    trashedFiles: EnteFile[];
    /**
     * Latest snapshot of people related state, as reported by
     * {@link usePeopleStateSnapshot}.
     */
    peopleState: PeopleState | undefined;

    /*--<  Derived state  >--*/

    /**
     * Collection IDs of archived collections.
     */
    archivedCollectionIDs: Set<number>;
    /**
     * Collection IDs of default hidden collections.
     */
    defaultHiddenCollectionIDs: Set<number>;
    /**
     * File IDs of the files that the user has hidden.
     */
    hiddenFileIDs: Set<number>;
    /**
     * File IDs of all the files that the user has marked as a favorite.
     */
    favoriteFileIDs: Set<number>;
    /**
     * User visible collection names indexed by collection IDs for fast lookup.
     *
     * This map will contain entries for all (both normal and hidden)
     * collections.
     */
    allCollectionNameByID: Map<number, string>;
    /**
     * A list of collection IDs to which a file belongs, indexed by file ID.
     */
    fileCollectionIDs: Map<number, number[]>;

    /*--<  Derived UI state  >--*/

    /**
     * A map of collections massage to a form suitable for being directly
     * consumed by the UI, indexed by the collection IDs.
     */
    collectionSummaries: Map<number, CollectionSummary>;
    /**
     * A version of {@link collectionSummaries} but for hidden collections.
     */
    hiddenCollectionSummaries: Map<number, CollectionSummary>;

    /*--<  In-flight updates  >--*/

    /**
     * File IDs of the files that have been just been deleted by the user.
     *
     * The delete on remote for these has either completed, or is currently in
     * flight, but the local state has not yet been updated. We stash these
     * changes here temporarily so that the UI can reflect the changes until our
     * local state also gets synced in a bit.
     */
    tempDeletedFileIDs: Set<number>;
    /**
     * Variant of {@link tempDeletedFileIDs} for files that have just been
     * hidden.
     */
    tempHiddenFileIDs: Set<number>;

    /*--<  State that underlies transient UI state  >--*/

    /**
     * The currently selected collection summary, if any.
     *
     * When present, this is used to derive the
     * {@link activeCollectionSummaryID} property of the {@link view}.
     *
     * UI code should use the {@link view}, this property is meant as the
     * underlying primitive state. In particular, this does not get reset when
     * we switch sections, which allows us to come back to the same active
     * collection (if possible) on switching back.
     */
    selectedCollectionSummaryID: number | undefined;
    /**
     * The currently selected person, if any.
     *
     * When present, it is used to derive the {@link activePerson} property of
     * the {@link view}.
     *
     * UI code should use the {@link view}, this property is meant as the
     * underlying primitive state. In particular, this does not get reset when
     * we switch sections, which allows us to come back to the same person (if
     * possible) on switching back.
     */
    selectedPersonID: string | undefined;
    /**
     * List of files that match the selected search option.
     *
     * This will be set only if we are showing search results.
     *
     * The search dropdown shows a list of options ("suggestions") that match
     * the user's search term. If the user selects from one of these options,
     * then we run a search to find all files that match that suggestion, and
     * set this value to the result.
     */
    searchResults: EnteFile[] | undefined;

    /*--<  Transient UI state  >--*/

    /**
     * The view, and the item within it, that the gallery is currently showing.
     *
     * This can be temporarily overridden when we display search results.
     */
    view: GalleryView | undefined;
    /**
     * `true` if we are in "search mode".
     *
     * We will always be in search mode if we are showing search results, but we
     * also may be in search mode earlier on smaller screens, where the search
     * input is only shown on entering search mode. See: [Note: "Search mode"].
     *
     * That is, {@link isInSearchMode} may be true even when
     * {@link searchResults} is undefined.
     */
    isInSearchMode: boolean;
    /**
     * The files to show, uniqued and sorted appropriately.
     */
    filteredFiles: EnteFile[];
}

export type GalleryAction =
    | {
          type: "mount";
          user: User;
          familyData: FamilyData;
          allCollections: Collection[];
          files: EnteFile[];
          hiddenFiles: EnteFile[];
          trashedFiles: EnteFile[];
      }
    | {
          type: "setNormalCollections";
          collections: Collection[];
      }
    | {
          type: "setAllCollections";
          collections: Collection[];
          hiddenCollections: Collection[];
      }
    | { type: "setFiles"; files: EnteFile[] }
    | { type: "fetchFiles"; files: EnteFile[] }
    | { type: "uploadFile"; file: EnteFile }
    | { type: "setHiddenFiles"; hiddenFiles: EnteFile[] }
    | { type: "fetchHiddenFiles"; hiddenFiles: EnteFile[] }
    | { type: "setTrashedFiles"; trashedFiles: EnteFile[] }
    | { type: "setPeopleState"; peopleState: PeopleState | undefined }
    | { type: "markTempDeleted"; files: EnteFile[] }
    | { type: "clearTempDeleted" }
    | { type: "markTempHidden"; files: EnteFile[] }
    | { type: "clearTempHidden" }
    | { type: "showAll" }
    | { type: "showHidden" }
    | { type: "showAlbums" }
    | {
          type: "showNormalOrHiddenCollectionSummary";
          collectionSummaryID: number | undefined;
      }
    | { type: "showPeople" }
    | { type: "showPerson"; personID: string }
    | { type: "searchResults"; searchResults: EnteFile[] }
    | { type: "enterSearchMode" }
    | { type: "exitSearch" }
    | { type: "setFilteredFiles"; filteredFiles: EnteFile[] };

const initialGalleryState: GalleryState = {
    user: undefined,
    familyData: undefined,
    collections: [],
    hiddenCollections: [],
    files: [],
    hiddenFiles: [],
    trashedFiles: [],
    peopleState: undefined,
    archivedCollectionIDs: new Set(),
    defaultHiddenCollectionIDs: new Set(),
    hiddenFileIDs: new Set(),
    favoriteFileIDs: new Set(),
    allCollectionNameByID: new Map(),
    fileCollectionIDs: new Map(),
    collectionSummaries: new Map(),
    hiddenCollectionSummaries: new Map(),
    tempDeletedFileIDs: new Set<number>(),
    tempHiddenFileIDs: new Set<number>(),
    selectedCollectionSummaryID: undefined,
    selectedPersonID: undefined,
    searchResults: undefined,
    view: undefined,
    filteredFiles: [],
    isInSearchMode: false,
};

const galleryReducer: React.Reducer<GalleryState, GalleryAction> = (
    state,
    action,
) => {
    if (process.env.NEXT_PUBLIC_ENTE_WIP_CL) console.log("dispatch", action);
    switch (action.type) {
        case "mount": {
            const [hiddenCollections, collections] = splitByPredicate(
                action.allCollections,
                isHiddenCollection,
            );
            const archivedCollectionIDs =
                deriveArchivedCollectionIDs(collections);
            const hiddenFileIDs = deriveHiddenFileIDs(action.hiddenFiles);
            const view = {
                type: "albums" as const,
                activeCollectionSummaryID: ALL_SECTION,
                activeCollection: undefined,
            }
            return {
                ...state,
                user: action.user,
                familyData: action.familyData,
                collections: collections,
                hiddenCollections: hiddenCollections,
                files: action.files,
                hiddenFiles: action.hiddenFiles,
                trashedFiles: action.trashedFiles,
                archivedCollectionIDs,
                defaultHiddenCollectionIDs:
                    deriveDefaultHiddenCollectionIDs(hiddenCollections),
                hiddenFileIDs,
                favoriteFileIDs: deriveFavoriteFileIDs(
                    collections,
                    action.files,
                ),
                allCollectionNameByID: createCollectionNameByID(
                    action.allCollections,
                ),
                fileCollectionIDs: createFileCollectionIDs(action.files),
                collectionSummaries: deriveCollectionSummaries(
                    action.user,
                    collections,
                    action.files,
                    action.trashedFiles,
                    archivedCollectionIDs,
                ),
                hiddenCollectionSummaries: deriveHiddenCollectionSummaries(
                    action.user,
                    hiddenCollections,
                    action.hiddenFiles,
                ),
                view,
                filteredFiles: deriveAlbumsFilteredFiles(
                    action.files,
                    archivedCollectionIDs,
                    hiddenFileIDs,
                    state.tempDeletedFileIDs,
                    state.tempHiddenFileIDs,
                    view,
                )
            };
        }
        case "setNormalCollections": {
            const archivedCollectionIDs = deriveArchivedCollectionIDs(
                action.collections,
            );
            return {
                ...state,
                collections: action.collections,
                archivedCollectionIDs,
                favoriteFileIDs: deriveFavoriteFileIDs(
                    action.collections,
                    state.files,
                ),
                allCollectionNameByID: createCollectionNameByID(
                    action.collections.concat(state.hiddenCollections),
                ),
                collectionSummaries: deriveCollectionSummaries(
                    ensure(state.user),
                    action.collections,
                    state.files,
                    state.trashedFiles,
                    archivedCollectionIDs,
                ),
            };
        }
        case "setAllCollections": {
            const archivedCollectionIDs = deriveArchivedCollectionIDs(
                action.collections,
            );
            return {
                ...state,
                collections: action.collections,
                hiddenCollections: action.hiddenCollections,
                archivedCollectionIDs,
                defaultHiddenCollectionIDs: deriveDefaultHiddenCollectionIDs(
                    action.hiddenCollections,
                ),
                favoriteFileIDs: deriveFavoriteFileIDs(
                    action.collections,
                    state.files,
                ),
                allCollectionNameByID: createCollectionNameByID(
                    action.collections.concat(action.hiddenCollections),
                ),
                collectionSummaries: deriveCollectionSummaries(
                    ensure(state.user),
                    action.collections,
                    state.files,
                    state.trashedFiles,
                    archivedCollectionIDs,
                ),
                hiddenCollectionSummaries: deriveHiddenCollectionSummaries(
                    ensure(state.user),
                    action.hiddenCollections,
                    state.hiddenFiles,
                ),
            };
        }
        case "setFiles": {
            const files = sortFiles(mergeMetadata(action.files));
            return {
                ...state,
                files,
                favoriteFileIDs: deriveFavoriteFileIDs(
                    state.collections,
                    files,
                ),
                fileCollectionIDs: createFileCollectionIDs(action.files),
                collectionSummaries: deriveCollectionSummaries(
                    ensure(state.user),
                    state.collections,
                    files,
                    state.trashedFiles,
                    state.archivedCollectionIDs,
                ),
            };
        }
        case "fetchFiles": {
            const files = sortFiles(
                mergeMetadata(
                    getLatestVersionFiles([...state.files, ...action.files]),
                ),
            );
            return {
                ...state,
                files,
                favoriteFileIDs: deriveFavoriteFileIDs(
                    state.collections,
                    files,
                ),
                fileCollectionIDs: createFileCollectionIDs(action.files),
                collectionSummaries: deriveCollectionSummaries(
                    ensure(state.user),
                    state.collections,
                    files,
                    state.trashedFiles,
                    state.archivedCollectionIDs,
                ),
            };
        }
        case "uploadFile": {
            const files = sortFiles([...state.files, action.file]);
            return {
                ...state,
                files,
                favoriteFileIDs: deriveFavoriteFileIDs(
                    state.collections,
                    files,
                ),
                fileCollectionIDs: createFileCollectionIDs(files),
                // TODO: Consider batching this instead of doing it per file
                // upload to speed up uploads. Perf test first though.
                collectionSummaries: deriveCollectionSummaries(
                    ensure(state.user),
                    state.collections,
                    files,
                    state.trashedFiles,
                    state.archivedCollectionIDs,
                ),
            };
        }
        case "setHiddenFiles": {
            const hiddenFiles = sortFiles(mergeMetadata(action.hiddenFiles));
            return {
                ...state,
                hiddenFiles,
                hiddenFileIDs: deriveHiddenFileIDs(hiddenFiles),
                hiddenCollectionSummaries: deriveHiddenCollectionSummaries(
                    ensure(state.user),
                    state.hiddenCollections,
                    hiddenFiles,
                ),
            };
        }
        case "fetchHiddenFiles": {
            const hiddenFiles = sortFiles(
                mergeMetadata(
                    getLatestVersionFiles([
                        ...state.hiddenFiles,
                        ...action.hiddenFiles,
                    ]),
                ),
            );
            return {
                ...state,
                hiddenFiles,
                hiddenFileIDs: deriveHiddenFileIDs(hiddenFiles),
                hiddenCollectionSummaries: deriveHiddenCollectionSummaries(
                    ensure(state.user),
                    state.hiddenCollections,
                    hiddenFiles,
                ),
            };
        }
        case "setTrashedFiles":
            return {
                ...state,
                trashedFiles: action.trashedFiles,
                collectionSummaries: deriveCollectionSummaries(
                    ensure(state.user),
                    state.collections,
                    state.files,
                    action.trashedFiles,
                    state.archivedCollectionIDs,
                ),
            };
        case "setPeopleState":
            return { ...state, peopleState: action.peopleState };
        case "markTempDeleted":
            return {
                ...state,
                tempDeletedFileIDs: new Set(
                    [...state.tempDeletedFileIDs].concat(
                        action.files.map((f) => f.id),
                    ),
                ),
            };
        case "clearTempDeleted":
            return { ...state, tempDeletedFileIDs: new Set() };
        case "markTempHidden":
            return {
                ...state,
                tempHiddenFileIDs: new Set(
                    [...state.tempHiddenFileIDs].concat(
                        action.files.map((f) => f.id),
                    ),
                ),
            };
        case "clearTempHidden":
            return { ...state, tempHiddenFileIDs: new Set() };
        case "showAll":
            return {
                ...state,
                searchResults: undefined,
                selectedCollectionSummaryID: undefined,
                view: {
                    type: "albums",
                    activeCollectionSummaryID: ALL_SECTION,
                    activeCollection: undefined,
                },
                isInSearchMode: false,
            };
        case "showHidden":
            return {
                ...state,
                searchResults: undefined,
                selectedCollectionSummaryID: undefined,
                view: {
                    type: "hidden-albums",
                    activeCollectionSummaryID: HIDDEN_ITEMS_SECTION,
                    activeCollection: undefined,
                },
                isInSearchMode: false,
            };
        case "showAlbums": {
            const { view, selectedCollectionSummaryID } =
                deriveAlbumsViewAndSelectedID(
                    state.collections,
                    state.collectionSummaries,
                    state.selectedCollectionSummaryID,
                );
            return {
                ...state,
                searchResults: undefined,
                selectedCollectionSummaryID,
                view,
                isInSearchMode: false,
            };
        }
        case "showNormalOrHiddenCollectionSummary":
            return {
                ...state,
                searchResults: undefined,
                selectedCollectionSummaryID: action.collectionSummaryID,
                view: {
                    type:
                        action.collectionSummaryID !== undefined &&
                        state.hiddenCollectionSummaries.has(
                            action.collectionSummaryID,
                        )
                            ? "hidden-albums"
                            : "albums",
                    activeCollectionSummaryID:
                        action.collectionSummaryID ?? ALL_SECTION,
                    activeCollection: state.collections
                        .concat(state.hiddenCollections)
                        .find(({ id }) => id === action.collectionSummaryID),
                },
                isInSearchMode: false,
            };
        case "showPeople": {
            const view = derivePeopleView(
                state.peopleState,
                state.tempDeletedFileIDs,
                state.tempHiddenFileIDs,
                state.selectedPersonID,
            );
            return {
                ...state,
                searchResults: undefined,
                selectedPersonID: view.activePerson?.id,
                view,
                isInSearchMode: false,
            };
        }
        case "showPerson": {
            const view = derivePeopleView(
                state.peopleState,
                state.tempDeletedFileIDs,
                state.tempHiddenFileIDs,
                action.personID,
            );
            return {
                ...state,
                searchResults: undefined,
                selectedPersonID: view.activePerson?.id,
                view,
                isInSearchMode: false,
            };
        }
        case "enterSearchMode":
            return { ...state, isInSearchMode: true };
        case "searchResults":
            return {
                ...state,
                searchResults: action.searchResults,
            };
        case "exitSearch":
            return {
                ...state,
                isInSearchMode: false,
                searchResults: undefined,
            };
        case "setFilteredFiles":
            return { ...state, filteredFiles: action.filteredFiles };
    }
};

export const useGalleryReducer = () =>
    useReducer(galleryReducer, initialGalleryState);

/**
 * File IDs themselves are unique across all the files for the user (in fact,
 * they're unique across all the files in an Ente instance). However, we still
 * can have multiple entries for the same file ID in our local database because
 * the unit of account is not actually a file, but a "Collection File": a
 * collection and file pair.
 *
 * For example, if the same file is symlinked into two collections, then we will
 * have two "Collection File" entries for it, both with the same file ID, but
 * with different collection IDs.
 *
 * This function returns files such that only one of these entries (the newer
 * one in case of dupes) is returned.
 */
export const uniqueFilesByID = (files: EnteFile[]) => {
    const seen = new Set<number>();
    return files.filter(({ id }) => {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
    });
};

/**
 * Helper function to compute archived collection IDs from their dependencies.
 */
const deriveArchivedCollectionIDs = (collections: Collection[]) =>
    new Set<number>(
        collections
            .filter(isArchivedCollection)
            .map((collection) => collection.id),
    );

/**
 * Helper function to compute the default hidden collection IDs from theirq
 * dependencies.
 */
const deriveDefaultHiddenCollectionIDs = (hiddenCollections: Collection[]) =>
    findDefaultHiddenCollectionIDs(hiddenCollections);

/**
 * Helper function to compute hidden file IDs from their dependencies.
 */
const deriveHiddenFileIDs = (hiddenFiles: EnteFile[]) =>
    new Set<number>(hiddenFiles.map((f) => f.id));

/**
 * Helper function to compute favorite file IDs from their dependencies.
 */
const deriveFavoriteFileIDs = (
    collections: Collection[],
    files: EnteFile[],
): Set<number> => {
    for (const collection of collections) {
        if (collection.type === CollectionType.favorites) {
            return new Set(
                files
                    .filter((file) => file.collectionID === collection.id)
                    .map((file): number => file.id),
            );
        }
    }
    return new Set();
};

/**
 * Helper function to compute collection summaries from their dependencies.
 */
export const deriveCollectionSummaries = (
    user: User,
    collections: Collection[],
    files: EnteFile[],
    trashedFiles: EnteFile[],
    archivedCollectionIDs: Set<number>,
) => {
    const collectionSummaries = createCollectionSummaries(
        user,
        collections,
        files,
    );

    const allSectionFiles = findAllSectionVisibleFiles(
        files,
        archivedCollectionIDs,
    );
    collectionSummaries.set(ALL_SECTION, {
        ...pseudoCollectionOptionsForFiles(allSectionFiles),
        id: ALL_SECTION,
        type: "all",
        name: t("section_all"),
    });
    collectionSummaries.set(TRASH_SECTION, {
        ...pseudoCollectionOptionsForFiles(trashedFiles),
        id: TRASH_SECTION,
        name: t("section_trash"),
        type: "trash",
        coverFile: undefined,
    });
    const archivedFiles = uniqueFilesByID(
        files.filter((file) => isArchivedFile(file)),
    );
    collectionSummaries.set(ARCHIVE_SECTION, {
        ...pseudoCollectionOptionsForFiles(archivedFiles),
        id: ARCHIVE_SECTION,
        name: t("section_archive"),
        type: "archive",
        coverFile: undefined,
    });

    return collectionSummaries;
};

const pseudoCollectionOptionsForFiles = (files: EnteFile[]) => ({
    coverFile: files[0],
    latestFile: files[0],
    fileCount: files.length,
    updationTime: files[0]?.updationTime,
});

/**
 * Helper function to compute hidden collection summaries from their
 * dependencies.
 */
export const deriveHiddenCollectionSummaries = (
    user: User,
    hiddenCollections: Collection[],
    hiddenFiles: EnteFile[],
) => {
    const hiddenCollectionSummaries = createCollectionSummaries(
        user,
        hiddenCollections,
        hiddenFiles,
    );

    const dhcIDs = findDefaultHiddenCollectionIDs(hiddenCollections);
    const defaultHiddenFiles = uniqueFilesByID(
        hiddenFiles.filter((file) => dhcIDs.has(file.collectionID)),
    );
    hiddenCollectionSummaries.set(HIDDEN_ITEMS_SECTION, {
        ...pseudoCollectionOptionsForFiles(defaultHiddenFiles),
        id: HIDDEN_ITEMS_SECTION,
        name: t("hidden_items"),
        type: "hiddenItems",
    });

    return hiddenCollectionSummaries;
};

const createCollectionSummaries = (
    user: User,
    collections: Collection[],
    files: EnteFile[],
) => {
    const collectionSummaries = new Map<number, CollectionSummary>();

    const filesByCollection = groupFilesByCollectionID(files);
    const coverFiles = findCoverFiles(collections, filesByCollection);

    let hasUncategorizedCollection = false;
    for (const collection of collections) {
        if (collection.type === CollectionType.uncategorized) {
            hasUncategorizedCollection = true;
        }

        let type: CollectionSummaryType;
        if (isIncomingShare(collection, user)) {
            if (isIncomingCollabShare(collection, user)) {
                type = "incomingShareCollaborator";
            } else {
                type = "incomingShareViewer";
            }
        } else if (isOutgoingShare(collection, user)) {
            type = "outgoingShare";
        } else if (isSharedOnlyViaLink(collection)) {
            type = "sharedOnlyViaLink";
        } else if (isArchivedCollection(collection)) {
            type = "archived";
        } else if (isDefaultHiddenCollection(collection)) {
            type = "defaultHidden";
        } else if (isPinnedCollection(collection)) {
            type = "pinned";
        } else {
            // Directly use the collection type
            // TODO: The constants can be aligned once collection type goes from
            // an enum to an union.
            switch (collection.type) {
                case CollectionType.folder:
                    type = "folder";
                    break;
                case CollectionType.favorites:
                    type = "favorites";
                    break;
                case CollectionType.album:
                    type = "album";
                    break;
                case CollectionType.uncategorized:
                    type = "uncategorized";
                    break;
            }
        }

        let name: string;
        if (type == "uncategorized") {
            name = t("section_uncategorized");
        } else if (type == "favorites") {
            name = t("favorites");
        } else {
            name = collection.name;
        }

        const collectionFiles = filesByCollection.get(collection.id);
        collectionSummaries.set(collection.id, {
            id: collection.id,
            type,
            name,
            latestFile: collectionFiles?.[0],
            coverFile: coverFiles.get(collection.id),
            fileCount: collectionFiles?.length ?? 0,
            updationTime: collection.updationTime,
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            order: collection.magicMetadata?.data?.order ?? 0,
        });
    }

    if (!hasUncategorizedCollection) {
        collectionSummaries.set(DUMMY_UNCATEGORIZED_COLLECTION, {
            ...pseudoCollectionOptionsForFiles([]),
            id: DUMMY_UNCATEGORIZED_COLLECTION,
            type: "uncategorized",
            name: t("section_uncategorized"),
        });
    }

    return collectionSummaries;
};

const findCoverFiles = (
    collections: Collection[],
    filesByCollection: Map<number, EnteFile[]>,
): Map<number, EnteFile> => {
    const coverFiles = new Map<number, EnteFile>();
    for (const collection of collections) {
        const collectionFiles = filesByCollection.get(collection.id);
        if (!collectionFiles || collectionFiles.length == 0) continue;

        let coverFile: EnteFile | undefined;

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        const coverID = collection.pubMagicMetadata?.data?.coverID;
        if (typeof coverID === "number" && coverID > 0) {
            coverFile = collectionFiles.find(({ id }) => id === coverID);
        }

        if (!coverFile) {
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            if (collection.pubMagicMetadata?.data?.asc) {
                coverFile = collectionFiles[collectionFiles.length - 1];
            } else {
                coverFile = collectionFiles[0];
            }
        }

        if (coverFile) {
            coverFiles.set(collection.id, coverFile);
        }
    }
    return coverFiles;
};

const isIncomingCollabShare = (collection: Collection, user: User) => {
    // TODO: Need to audit the types
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const sharee = collection.sharees?.find((sharee) => sharee.id === user.id);
    return sharee?.role === COLLECTION_ROLE.COLLABORATOR;
};

const isOutgoingShare = (collection: Collection, user: User) =>
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    collection.owner.id === user.id && collection.sharees?.length > 0;

const isSharedOnlyViaLink = (collection: Collection) =>
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    collection.publicURLs?.length && !collection.sharees?.length;

/**
 * Return all list of files that should be shown in the "All" section.
 */
const findAllSectionVisibleFiles = (
    files: EnteFile[],
    archivedCollectionIDs: Set<number>,
) =>
    uniqueFilesByID(
        files.filter(
            (file) =>
                !isArchivedFile(file) &&
                !archivedCollectionIDs.has(file.collectionID),
        ),
    );

/**
 * Helper function to derive the {@link GalleryView} from its dependencies when
 * we are switching to (or back to) the "albums" view.
 */
const deriveAlbumsViewAndSelectedID = (
    collections: GalleryState["collections"],
    collectionSummaries: GalleryState["collectionSummaries"],
    selectedCollectionSummaryID: GalleryState["selectedCollectionSummaryID"],
) => {
    // Make sure that the last selected ID is still valid by searching for it.
    const activeCollectionSummaryID = selectedCollectionSummaryID
        ? collectionSummaries.get(selectedCollectionSummaryID)?.id
        : undefined;
    const activeCollection = activeCollectionSummaryID
        ? collections.find(({ id }) => id == activeCollectionSummaryID)
        : undefined;
    return {
        selectedCollectionSummaryID: activeCollectionSummaryID,
        view: {
            type: "albums" as const,
            activeCollectionSummaryID: activeCollectionSummaryID ?? ALL_SECTION,
            activeCollection,
        },
    };
};

/**
 * Helper function to derive the {@link GalleryView} from its dependencies when
 * we are switching to (or back to) the "people" view.
 */
const derivePeopleView = (
    peopleState: GalleryState["peopleState"],
    tempDeletedFileIDs: GalleryState["tempDeletedFileIDs"],
    tempHiddenFileIDs: GalleryState["tempHiddenFileIDs"],
    selectedPersonID: GalleryState["selectedPersonID"],
): Extract<GalleryView, { type: "people" }> => {
    let people = peopleState?.people ?? [];
    let visiblePeople = peopleState?.visiblePeople ?? [];
    if (tempDeletedFileIDs.size + tempHiddenFileIDs.size > 0) {
        // Prune the in-memory temp updates from the actual state to
        // obtain the UI state. Kept inside an preflight check to so
        // that the common path remains fast.
        const filterTemp = (ps: Person[]) =>
            ps
                .map((p) => ({
                    ...p,
                    fileIDs: p.fileIDs.filter(
                        (id) =>
                            !tempDeletedFileIDs.has(id) &&
                            !tempHiddenFileIDs.has(id),
                    ),
                }))
                .filter((p) => p.fileIDs.length > 0);
        people = filterTemp(people);
        visiblePeople = filterTemp(visiblePeople);
    }
    const findByID = (ps: Person[]) => ps.find((p) => p.id == selectedPersonID);
    let activePerson = findByID(visiblePeople);
    if (!activePerson) {
        // This might be one of the normally hidden small clusters.
        activePerson = findByID(people);
        if (activePerson) {
            // Temporarily add this person's entry to the list of people
            // surfaced in the people view.
            visiblePeople.push(activePerson);
        } else {
            // We don't have an "All" pseudo-album in people view, so default to
            // the first person in the list (if any).
            activePerson = visiblePeople[0];
        }
    }

    return { type: "people", visiblePeople, activePerson };
};

/**
 * Helper function to compute the sorted list of files to show when we're
 * showing either "albums" or "hidden-albums".
 */
export const deriveAlbumishFilteredFiles = (state: GalleryState) => {
    const view = state.view;
    if (view?.type == "albums") {
        return deriveAlbumsFilteredFiles(state, view);
    } else if (view?.type == "hidden-albums") {
        return deriveHiddenAlbumsFilteredFiles(state, view);
    } else {
        // TODO: Setup the types so that we don't come here.
        throw new Error("Not implemented");
    }
};

/**
 * Helper function to compute the sorted list of files to show when we're
 * in the "albums" view.
 */
export const deriveAlbumsFilteredFiles = (
    files: GalleryState["files"],
    archivedCollectionIDs: GalleryState["archivedCollectionIDs"],
    hiddenFileIDs: GalleryState["hiddenFileIDs"],
    tempDeletedFileIDs: GalleryState["tempDeletedFileIDs"],
    tempHiddenFileIDs: GalleryState["tempHiddenFileIDs"],
    view: Extract<GalleryView, { type: "albums" | "hidden-albums" }>,
) => {
    const activeCollectionSummaryID = view.activeCollectionSummaryID;
    const filteredFiles = files.filter((file) => {
        if (tempDeletedFileIDs.has(file.id)) return false;
        if (hiddenFileIDs.has(file.id)) return false;
        if (tempHiddenFileIDs.has(file.id)) return false;

        // Files in archived collections can only be seen in their respective
        // collection.
        if (archivedCollectionIDs.has(file.collectionID)) {
            return activeCollectionSummaryID === file.collectionID;
        }

        // Archived files can only be seen in the archive section, or in their
        // respective collection.
        if (isArchivedFile(file)) {
            return (
                activeCollectionSummaryID === ARCHIVE_SECTION ||
                activeCollectionSummaryID === file.collectionID
            );
        }

        // Show all remaining (non-hidden, non-archived) files in "All".
        if (activeCollectionSummaryID === ALL_SECTION) {
            return true;
        }

        // Show files that belong to the active collection.
        return activeCollectionSummaryID === file.collectionID;
    });

    return sortAndUniqueFilteredFiles(filteredFiles, view.activeCollection);
};

/**
 * Helper function to compute the sorted list of files to show when we're
 * showing the "Trash".
 */
export const deriveTrashFilteredFiles = ({
    files,
    trashedFiles,
    tempDeletedFileIDs,
}: GalleryState) =>
    uniqueFilesByID([
        ...trashedFiles,
        ...files.filter((file) => tempDeletedFileIDs.has(file.id)),
    ]);

/**
 * Helper function to compute the sorted list of files to show when we're
 * in the "hidden-albums" view.
 */
export const deriveHiddenAlbumsFilteredFiles = (
    hiddenFiles: GalleryState["hiddenFiles"],
    defaultHiddenCollectionIDs: GalleryState["defaultHiddenCollectionIDs"],
    tempDeletedFileIDs: GalleryState["tempDeletedFileIDs"],
    view: Extract<GalleryView, { type: "albums" | "hidden-albums" }>,
) => {
    const activeCollectionSummaryID = view.activeCollectionSummaryID;
    const filteredFiles = hiddenFiles.filter((file) => {
        if (tempDeletedFileIDs.has(file.id)) return false;

        // "Hidden" shows all standalone hidden files.
        if (
            activeCollectionSummaryID === HIDDEN_ITEMS_SECTION &&
            defaultHiddenCollectionIDs.has(file.collectionID)
        ) {
            return true;
        }

        // Show files that belong to the active collection.
        return activeCollectionSummaryID === file.collectionID;
    });

    return sortAndUniqueFilteredFiles(filteredFiles, view.activeCollection);
};

/**
 * Prepare the list of files for being shown in the gallery.
 *
 * This functions uniques the given collection files so that there is only one
 * entry per file ID. Then it sorts them if the active collection prefers them
 * to be sorted oldest first (by default, lists of collection files are sorted
 * newest first, and we assume that {@link files} are already sorted that way).
 */
const sortAndUniqueFilteredFiles = (
    files: EnteFile[],
    activeCollection: Collection | undefined,
) => {
    const uniqueFiles = uniqueFilesByID(files);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const sortAsc = activeCollection?.pubMagicMetadata?.data?.asc ?? false;
    return sortAsc ? sortFiles(uniqueFiles, true) : uniqueFiles;
};

/**
 * Helper function to compute the sorted list of files to show when we're
 * in the "people" view.
 */
export const derivePeopleFilteredFiles = (
    { files }: GalleryState,
    view: Extract<GalleryView, { type: "people" }>,
) => {
    const pfSet = new Set(view.activePerson?.fileIDs ?? []);
    return uniqueFilesByID(
        files.filter(({ id }) => {
            if (!pfSet.has(id)) return false;
            return true;
        }),
    );
};
