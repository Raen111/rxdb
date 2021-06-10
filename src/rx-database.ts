import randomToken from 'random-token';
import { IdleQueue } from 'custom-idle-queue';
import { BroadcastChannel } from 'broadcast-channel';

import type { LeaderElector } from './plugins/leader-election';
import type {
    CollectionsOfDatabase,
    PouchDBInstance,
    RxDatabase,
    RxCollectionCreator,
    RxJsonSchema,
    RxCollection,
    PouchSettings,
    ServerOptions,
    RxDatabaseCreator,
    RxDumpDatabase,
    RxDumpDatabaseAny,
    RxCollectionCreatorBase,
    AllMigrationStates,
    ServerResponse,
    BackupOptions,
    RxStorage,
    RxStorageKeyObjectInstance,
    RxStorageInstance,
    BulkWriteRow,
    RxChangeEvent
} from './types';

import {
    pluginMissing,
    flatClone
} from './util';
import {
    newRxError
} from './rx-error';
import {
    createRxSchema,
    getPseudoSchemaForVersion
} from './rx-schema';
import {
    isRxChangeEventIntern,
    RxChangeEventBroadcastChannelData
} from './rx-change-event';
import { overwritable } from './overwritable';
import {
    runPluginHooks,
    runAsyncPluginHooks
} from './hooks';
import {
    Subject,
    Subscription,
    Observable
} from 'rxjs';
import {
    filter
} from 'rxjs/operators';

import {
    PouchDB,
    isLevelDown
} from './pouch-db';

import {
    createRxCollection
} from './rx-collection';
import {
    getRxStoragePouch,
    RxStorageInstancePouch,
    RxStorageKeyObjectInstancePouch,
    RxStoragePouch
} from './rx-storage-pouchdb';
import {
    findLocalDocument,
    getAllDocuments,
    getSingleDocument,
    INTERNAL_STORAGE_NAME,
    storageChangeEventToRxChangeEvent,
    writeSingle
} from './rx-storage-helper';
import type { RxBackupState } from './plugins/backup';

/**
 * stores the combinations
 * of used database-names with their adapters
 * so we can throw when the same database is created more then once
 */
const USED_COMBINATIONS: { [k: string]: any[] } = {};

let DB_COUNT = 0;

// stores information about the collections
declare type InternalStoreDocumentData = {
    _id: string;
    schema: RxJsonSchema;
    schemaHash: string;
    version: number;
};

export class RxDatabaseBase<
    Collections = CollectionsOfDatabase
    > {

    // TODO use type RxStorage when rx-storage finished implemented
    public storage: RxStoragePouch;
    /**
     * Stores information documents about the collections of the database
     */
    public internalStore: RxStorageInstancePouch<InternalStoreDocumentData> = {} as any;
    /**
     * Stores the local documents which are attached to this database.
     */
    public localDocumentsStore: RxStorageKeyObjectInstancePouch = {} as any;

    constructor(
        public name: string,
        public adapter: any,
        public password: any,
        public multiInstance: boolean,
        public eventReduce: boolean = false,
        public options: any = {},
        public pouchSettings: PouchSettings,
    ) {
        this.storage = getRxStoragePouch(adapter, pouchSettings);

        this.collections = {} as any;
        DB_COUNT++;
    }

    get $(): Observable<RxChangeEvent<any>> {
        return this.observable$;
    }

    public idleQueue: IdleQueue = new IdleQueue();
    public readonly token: string = randomToken(10);
    public _subs: Subscription[] = [];
    public destroyed: boolean = false;
    public collections: Collections;
    private subject: Subject<RxChangeEvent> = new Subject();
    private observable$: Observable<RxChangeEvent> = this.subject.asObservable();
    public broadcastChannel?: BroadcastChannel;
    public storageToken?: string;
    public broadcastChannel$?: Subject<RxChangeEvent>;

    /**
     * removes all internal collection-info
     * only use this if you have to upgrade from a major rxdb-version
     * do NEVER use this to change the schema of a collection
     */
    async dangerousRemoveCollectionInfo(): Promise<void> {
        const allDocs = await getAllDocuments(this.internalStore);
        const writeData: BulkWriteRow<InternalStoreDocumentData>[] = allDocs.map(doc => {
            const deletedDoc = flatClone(doc);
            deletedDoc._deleted = true;
            return {
                previous: doc,
                document: deletedDoc
            }
        });
        await this.internalStore.bulkWrite(writeData);
    }

    /**
     * spawns a new pouch-instance
     */
    public async _spawnStorageInstance(
        collectionName: string,
        schema: RxJsonSchema,
        pouchSettings: PouchSettings = {}
    ): Promise<PouchDBInstance> {
        const instance = await this.storage.createStorageInstance(
            {
                databaseName: this.name,
                collectionName,
                schema,
                options: pouchSettings
            }
        );
        return instance.internals.pouch;
    }

    /**
     * This is the main handle-point for all change events
     * ChangeEvents created by this instance go:
     * RxDocument -> RxCollection -> RxDatabase.$emit -> MultiInstance
     * ChangeEvents created by other instances go:
     * MultiInstance -> RxDatabase.$emit -> RxCollection -> RxDatabase
     */
    $emit(changeEvent: RxChangeEvent) {
        console.log('RxDatabase(' + this.token + ').$emit:');
        console.dir(changeEvent);

        // emit into own stream
        this.subject.next(changeEvent);

        // write to socket if event was created by this instance



        if (changeEvent.databaseToken === this.token) {
            writeToSocket(this as any, changeEvent);
        }
    }

    /**
     * removes the collection-doc from this._collectionsPouch
     */
    async removeCollectionDoc(name: string, schema: any): Promise<void> {
        const docId = _collectionNamePrimary(name, schema);
        const doc = await getSingleDocument(
            this.internalStore,
            docId
        );
        if (!doc) {
            throw new Error('this should never happen');
        }
        const writeDoc = flatClone(doc);
        writeDoc._deleted = true;
        await this.lockedRun(
            () => this.internalStore.bulkWrite([{
                document: writeDoc,
                previous: doc
            }])
        );
    }

    /**
     * creates multiple RxCollections at once
     * to be much faster by saving db txs and doing stuff in bulk-operations
     * This function is not called often, but mostly in the critical path at the initial page load
     * So it must be as fast as possible
     */
    async addCollections(collectionCreators: {
        // TODO instead of [name: string] only allow keyof Collections
        [name: string]: RxCollectionCreatorBase
    }): Promise<{ [key: string]: RxCollection }> {
        // get local management docs in bulk request
        const collectionDocs = await this.internalStore.findDocumentsById(
            Object.keys(collectionCreators)
                .map(name => _collectionNamePrimary(name, collectionCreators[name].schema))
        );

        const internalDocByCollectionName: any = {};
        Array.from(collectionDocs.entries()).forEach(([key, doc]) => {
            internalDocByCollectionName[key] = doc;
        });

        const schemaHashByName: { [k: string]: string } = {};
        const collections = await Promise.all(
            Object.entries(collectionCreators).map(([name, args]) => {
                const internalDoc = internalDocByCollectionName[_collectionNamePrimary(name, collectionCreators[name].schema)];
                const useArgs: RxCollectionCreator = flatClone(args) as any;
                useArgs.name = name;
                const schema = createRxSchema(args.schema);
                schemaHashByName[name] = schema.hash;
                (useArgs as any).schema = schema;
                (useArgs as any).database = this;

                // TODO check if already exists and schema hash has changed

                // collection already exists
                if ((this.collections as any)[name]) {
                    throw newRxError('DB3', {
                        name
                    });
                }

                // collection already exists but has different schema
                if (internalDoc && internalDoc.schemaHash !== schemaHashByName[name]) {
                    throw newRxError('DB6', {
                        name: name,
                        previousSchemaHash: internalDoc.schemaHash,
                        schemaHash: schemaHashByName[name]
                    });
                }

                // run hooks
                const hookData: RxCollectionCreator = flatClone(args) as any;
                (hookData as any).database = this;
                hookData.name = name;
                runPluginHooks('preCreateRxCollection', hookData);

                return createRxCollection(useArgs, !!internalDoc);
            })
        );

        const bulkPutDocs: BulkWriteRow<InternalStoreDocumentData>[] = [];
        const ret: { [key: string]: RxCollection } = {};
        collections.forEach(collection => {
            const name = collection.name;
            ret[name] = collection;
            if (
                collection.schema.crypt &&
                !this.password
            ) {
                throw newRxError('DB7', {
                    name
                });
            }

            // add to bulk-docs list
            if (!internalDocByCollectionName[name]) {
                bulkPutDocs.push({
                    document: {
                        _id: _collectionNamePrimary(name, collectionCreators[name].schema),
                        schemaHash: schemaHashByName[name],
                        schema: collection.schema.normalized,
                        version: collection.schema.version,
                        _attachments: {}
                    }
                });
            }

            // set as getter to the database
            (this.collections as any)[name] = collection;
            if (!(this as any)[name]) {
                Object.defineProperty(this, name, {
                    get: () => (this.collections as any)[name]
                });
            }
        });

        // make a single call to the pouchdb instance
        if (bulkPutDocs.length > 0) {
            await this.internalStore.bulkWrite(bulkPutDocs);
        }

        return ret;
    }

    /**
     * create or fetch a collection
     * @deprecated use addCollections() instead, it is faster and better typed
     */
    collection<
        RxDocumentType = any,
        OrmMethods = {},
        StaticMethods = { [key: string]: any }
    >(args: RxCollectionCreator): Promise<
        RxCollection<
            RxDocumentType,
            OrmMethods,
            StaticMethods
        >
    > {
        if (typeof args === 'string') {
            return Promise.resolve(this.collections[args]);
        }

        // collection() is deprecated, call new bulk-creation method
        return this.addCollections({
            [args.name]: args
        }).then(colObject => {
            return colObject[args.name] as any;
        });
    }

    /**
     * delete all data of the collection and its previous versions
     */
    removeCollection(collectionName: string): Promise<void> {
        if ((this.collections as any)[collectionName]) {
            (this.collections as any)[collectionName].destroy();
        }

        // remove schemas from internal db
        return _removeAllOfCollection(this as any, collectionName)
            // get all relevant pouchdb-instances
            .then(knownVersions => {
                return Promise.all(
                    knownVersions
                        .map(v => {
                            return this.storage.createStorageInstance(
                                {
                                    databaseName: this.name,
                                    collectionName,
                                    schema: getPseudoSchemaForVersion(v),
                                    options: {}
                                }
                            );
                        })
                );
            })
            // remove documents
            .then(storageInstance => {
                return Promise.all(
                    storageInstance.map(
                        instance => this.lockedRun(
                            () => instance.remove()
                        )
                    )
                );
            })
            .then(() => { });
    }

    /**
     * runs the given function between idleQueue-locking
     */
    lockedRun<T>(fn: (...args: any[]) => T): T extends Promise<any> ? T : Promise<T> {
        return this.idleQueue.wrapCall(fn) as any;
    }

    requestIdlePromise() {
        return this.idleQueue.requestIdlePromise();
    }

    /**
     * Export database to a JSON friendly format.
     * @param _decrypted
     * When true, all encrypted values will be decrypted.
     */
    dump(_decrypted: boolean, _collections?: string[]): Promise<RxDumpDatabase<Collections>>;
    dump(_decrypted?: false, _collections?: string[]): Promise<RxDumpDatabaseAny<Collections>>;
    dump(_decrypted: boolean = false, _collections?: string[]): Promise<any> {
        throw pluginMissing('json-dump');
    }

    /**
     * Import the parsed JSON export into the collection.
     * @param _exportedJSON The previously exported data from the `<db>.dump()` method.
     * @note When an interface is loaded in this collection all base properties of the type are typed as `any`
     * since data could be encrypted.
     */
    importDump(_exportedJSON: RxDumpDatabaseAny<Collections>): Promise<void> {
        throw pluginMissing('json-dump');
    }

    /**
     * spawn server
     */
    server(_options?: ServerOptions): ServerResponse {
        throw pluginMissing('server');
    }

    backup(_options: BackupOptions): RxBackupState {
        throw pluginMissing('backup');
    }

    public leaderElector(): LeaderElector {
        throw pluginMissing('leader-election');
    }

    public isLeader(): boolean {
        throw pluginMissing('leader-election');
    }
    /**
     * returns a promise which resolves when the instance becomes leader
     */
    public waitForLeadership(): Promise<boolean> {
        throw pluginMissing('leader-election');
    }

    public migrationStates(): Observable<AllMigrationStates> {
        throw pluginMissing('migration');
    }

    /**
     * destroys the database-instance and all collections
     */
    public destroy(): Promise<boolean> {
        if (this.destroyed) return Promise.resolve(false);
        runPluginHooks('preDestroyRxDatabase', this);
        DB_COUNT--;
        this.destroyed = true;

        this._subs.map(sub => sub.unsubscribe());

        // first wait until db is idle
        return this.requestIdlePromise()
            // destroy all collections
            .then(() => Promise.all(
                Object.keys(this.collections)
                    .map(key => (this.collections as any)[key])
                    .map(col => col.destroy())
            ))
            // destroy internal storage instances
            .then(() => this.internalStore.close ? this.internalStore.close() : null)
            // close broadcastChannel if exists
            .then(() => this.broadcastChannel ? this.broadcastChannel.close() : Promise.resolve())
            // remove combination from USED_COMBINATIONS-map
            .then(() => _removeUsedCombination(this.name, this.adapter))
            .then(() => true);
    }

    /**
     * deletes the database and its stored data
     */
    remove(): Promise<void> {
        return this
            .destroy()
            .then(() => removeRxDatabase(this.name, this.adapter));
    }
}

/**
 * checks if an instance with same name and adapter already exists
 * @throws {RxError} if used
 */
function _isNameAdapterUsed(
    name: string,
    adapter: any
) {
    if (!USED_COMBINATIONS[name])
        return false;

    let used = false;
    USED_COMBINATIONS[name].forEach(ad => {
        if (ad === adapter)
            used = true;
    });
    if (used) {
        throw newRxError('DB8', {
            name,
            adapter,
            link: 'https://pubkey.github.io/rxdb/rx-database.html#ignoreduplicate'
        });
    }
}

function _removeUsedCombination(name: string, adapter: any) {
    if (!USED_COMBINATIONS[name])
        return;

    const index = USED_COMBINATIONS[name].indexOf(adapter);
    USED_COMBINATIONS[name].splice(index, 1);
}

/**
 * to not confuse multiInstance-messages with other databases that have the same
 * name and adapter, but do not share state with this one (for example in-memory-instances),
 * we set a storage-token and use it in the broadcast-channel
 */
export async function _ensureStorageTokenExists<Collections = any>(rxDatabase: RxDatabase<Collections>): Promise<string> {
    const storageTokenDocumentId = 'storageToken';
    const storageTokenDoc = await findLocalDocument<{ value: string }>(rxDatabase.localDocumentsStore, storageTokenDocumentId);
    if (!storageTokenDoc) {
        const storageToken = randomToken(10);
        await rxDatabase.localDocumentsStore.bulkWrite([{
            document: {
                _id: storageTokenDocumentId,
                value: storageToken,
                _attachments: {}

            }
        }]);
        return storageToken;
    } else {
        return storageTokenDoc.value;
    }
}

/**
 * writes the changeEvent to the broadcastChannel
 */
export function writeToSocket(
    rxDatabase: RxDatabase,
    changeEvent: RxChangeEvent
): Promise<boolean> {
    if (rxDatabase.destroyed) {
        return Promise.resolve(false);
    }

    console.log('write event to socket:');
    console.dir(changeEvent);

    if (
        rxDatabase.multiInstance &&
        !isRxChangeEventIntern(changeEvent) &&
        rxDatabase.broadcastChannel
    ) {
        const sendOverChannel: RxChangeEventBroadcastChannelData = {
            cE: changeEvent,
            storageToken: rxDatabase.storageToken as string
        };
        console.log(':sendOverChannel:');
        console.dir(sendOverChannel);
        return rxDatabase.broadcastChannel
            .postMessage(sendOverChannel)
            .then(() => true);
    } else
        return Promise.resolve(false);
}

/**
 * returns the primary for a given collection-data
 * used in the internal pouchdb-instances
 */
export function _collectionNamePrimary(name: string, schema: RxJsonSchema) {
    return name + '-' + schema.version;
}

/**
 * removes all internal docs of a given collection
 * @return resolves all known collection-versions
 */
export function _removeAllOfCollection(
    rxDatabase: RxDatabase,
    collectionName: string
): Promise<number[]> {
    return rxDatabase.lockedRun(
        () => getAllDocuments(rxDatabase.internalStore)
    ).then((data) => {
        const relevantDocs = data
            .filter((doc) => {
                const name = doc._id.split('-')[0];
                return name === collectionName;
            });
        return Promise.all(
            relevantDocs
                .map(
                    doc => {
                        const writeDoc = flatClone(doc);
                        writeDoc._deleted = true;
                        return rxDatabase.lockedRun(
                            () => writeSingle(
                                rxDatabase.internalStore,
                                {
                                    previous: doc,
                                    document: writeDoc
                                }
                            )
                        );
                    }
                )
        ).then(() => relevantDocs.map((doc: any) => doc.version));
    });
}

function _prepareBroadcastChannel<Collections>(rxDatabase: RxDatabase<Collections>): void {
    // broadcastChannel
    rxDatabase.broadcastChannel = new BroadcastChannel(
        'RxDB:' +
        rxDatabase.name + ':' +
        'socket'
    );
    rxDatabase.broadcastChannel$ = new Subject();
    rxDatabase.broadcastChannel.onmessage = (msg: RxChangeEventBroadcastChannelData) => {


        if (msg.storageToken !== rxDatabase.storageToken) return; // not same storage-state
        if (msg.cE.databaseToken === rxDatabase.token) return; // same db
        const changeEvent = msg.cE;

        console.log('broadcastChannel(' + rxDatabase.token + ') onmessage:');
        console.dir(msg);

        (rxDatabase.broadcastChannel$ as any).next(changeEvent);
    };


    // TODO only subscribe when something is listening to the event-chain
    rxDatabase._subs.push(
        rxDatabase.broadcastChannel$.subscribe((cE: RxChangeEvent) => {
            rxDatabase.$emit(cE);
        })
    );
}


async function createRxDatabaseStorageInstances<RxDocType, Internals, InstanceCreationOptions>(
    storage: RxStorage<Internals, InstanceCreationOptions>,
    databaseName: string,
    options: InstanceCreationOptions
): Promise<{
    internalStore: RxStorageInstance<RxDocType, Internals, InstanceCreationOptions>,
    localDocumentsStore: RxStorageKeyObjectInstance<Internals, InstanceCreationOptions>
}> {
    const internalStore = await storage.createStorageInstance<RxDocType>(
        {
            databaseName,
            collectionName: INTERNAL_STORAGE_NAME,
            schema: getPseudoSchemaForVersion(0),
            options
        }
    );

    const localDocumentsStore = await storage.createKeyObjectStorageInstance(
        databaseName,
        // TODO having to set an empty string here is ugly.
        // we should change the rx-storage interface to account for non-collection storage instances.
        '',
        options
    );

    return {
        internalStore,
        localDocumentsStore
    };
}

/**
 * do the async things for this database
 */
async function prepare<Collections, Internals, InstanceCreationOptions>(
    rxDatabase: RxDatabase<Collections>
): Promise<void> {
    const storageInstances = await createRxDatabaseStorageInstances<
        { _id: string },
        Internals,
        InstanceCreationOptions
    >(
        rxDatabase.storage as any,
        rxDatabase.name,
        rxDatabase.pouchSettings as any
    );

    rxDatabase.internalStore = storageInstances.internalStore as any;
    rxDatabase.localDocumentsStore = storageInstances.localDocumentsStore as any;

    const localDocsSub = rxDatabase.localDocumentsStore.changeStream().subscribe(
        rxStorageChangeEvent => {
            rxDatabase.$emit(
                storageChangeEventToRxChangeEvent(
                    true,
                    rxStorageChangeEvent,
                    rxDatabase as any
                )
            );
        }
    );
    rxDatabase._subs.push(localDocsSub);

    rxDatabase.storageToken = await _ensureStorageTokenExists<Collections>(rxDatabase);
    if (rxDatabase.multiInstance) {
        _prepareBroadcastChannel<Collections>(rxDatabase);
    }
}

export function createRxDatabase<Collections = { [key: string]: RxCollection }>({
    name,
    adapter,
    password,
    multiInstance = true,
    eventReduce = false,
    ignoreDuplicate = false,
    options = {},
    pouchSettings = {}
}: RxDatabaseCreator): Promise<RxDatabase<Collections>> {

    runPluginHooks('preCreateRxDatabase', {
        name,
        adapter,
        password,
        multiInstance,
        eventReduce,
        ignoreDuplicate,
        options,
        pouchSettings
    });

    // check if pouchdb-adapter
    if (typeof adapter === 'string') {
        // TODO make a function hasAdapter()
        if (!(PouchDB as any).adapters || !(PouchDB as any).adapters[adapter]) {
            throw newRxError('DB9', {
                adapter
            });
        }
    } else {
        isLevelDown(adapter);
        if (!(PouchDB as any).adapters || !(PouchDB as any).adapters.leveldb) {
            throw newRxError('DB10', {
                adapter
            });
        }
    }

    if (password) {
        overwritable.validatePassword(password);
    }

    // check if combination already used
    if (!ignoreDuplicate) {
        _isNameAdapterUsed(name, adapter);
    }

    // add to used_map
    if (!USED_COMBINATIONS[name]) {
        USED_COMBINATIONS[name] = [];
    }
    USED_COMBINATIONS[name].push(adapter);

    const rxDatabase: RxDatabase<Collections> = new RxDatabaseBase(
        name,
        adapter,
        password,
        multiInstance,
        eventReduce,
        options,
        pouchSettings
    ) as any;

    return prepare(rxDatabase)
        .then(() => runAsyncPluginHooks('createRxDatabase', rxDatabase))
        .then(() => rxDatabase);
}

/**
 * removes the database and all its known data
 */
export async function removeRxDatabase(
    databaseName: string,
    adapter: any
): Promise<any> {
    const storage = getRxStoragePouch(adapter);

    const storageInstance = await createRxDatabaseStorageInstances(
        storage,
        databaseName,
        {}
    );

    const docs = await getAllDocuments<{ _id: string }>(storageInstance.internalStore as any);
    await Promise.all(
        docs
            .map((colDoc) => colDoc._id)
            .map(async (id: string) => {
                const split = id.split('-');
                const name = split[0];
                const version = parseInt(split[1], 10);
                const instance = await storage.createStorageInstance(
                    {
                        databaseName,
                        collectionName: name,
                        schema: getPseudoSchemaForVersion(version),
                        options: {}
                    }
                );
                return instance.remove();
            })
    );

    return Promise.all([
        storageInstance.internalStore.remove(),
        storageInstance.localDocumentsStore.remove()
    ]);
}

/**
 * check if the given adapter can be used
 */
export function checkAdapter(adapter: any): Promise<boolean> {
    return overwritable.checkAdapter(adapter);
}

export function isRxDatabase(obj: any) {
    return obj instanceof RxDatabaseBase;
}

export function dbCount(): number {
    return DB_COUNT;
}
