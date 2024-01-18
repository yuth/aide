/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FormattingOptions } from 'vs/base/common/jsonFormatter';
import { IUserDataSyncUtilService } from 'vs/platform/userDataSync/common/userDataSync';

export async function merge(localContent: string, remoteContent: string, baseContent: string | null, formattingOptions: FormattingOptions, userDataSyncUtilService: IUserDataSyncUtilService): Promise<{ mergeContent: string; hasChanges: boolean; hasConflicts: boolean }> {
	return { mergeContent: localContent, hasChanges: false, hasConflicts: false };
}
